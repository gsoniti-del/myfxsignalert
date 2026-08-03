// netlify/functions/signal-cron.mjs
// Background alerter for Signal Desk. Runs on a schedule, evaluates the SAME
// six-factor confluence strategy server-side, and pushes to Telegram and/or
// email when a fresh signal appears on the latest CLOSED bar.
//
// Stateless dedup: it fires only when the signal on the last closed bar differs
// from the bar before it — so no database is needed. IMPORTANT: set the cron
// interval equal to your signal timeframe (default: 15 min) so each run lands
// on a new closed bar and you get exactly one alert per transition.
//
// ---- Environment variables (set in Netlify → Site config → Environment) ----
//   Telegram (optional):  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Email via Resend (optional): RESEND_API_KEY, ALERT_EMAIL_TO
//                                ALERT_EMAIL_FROM (default onboarding@resend.dev)
//   Strategy (optional):  SIGNAL_TF (default 15min), CONF_THRESHOLD (default 60),
//                         ATR_MULT (default 1.5), USE_HTF ("1"/"0", default 1)
// ---------------------------------------------------------------------------

export const config = { schedule: "*/15 * * * *" }; // change to match SIGNAL_TF

const TF        = process.env.SIGNAL_TF || "15min";
const THRESH    = +(process.env.CONF_THRESHOLD || 60);
const ATR_MULT  = +(process.env.ATR_MULT || 1.5);
const USE_HTF   = (process.env.USE_HTF ?? "1") !== "0";

const INSTRUMENTS = [
  { id:"US30",   name:"US30",    sub:"Dow Jones 30", yahoo:"^DJI",      digits:1 },
  { id:"NAS100", name:"NASDAQ",  sub:"US Tech 100",  yahoo:"^NDX",      digits:1 },
  { id:"GOLD",   name:"GOLD",    sub:"XAU/USD",      yahoo:"GC=F",      digits:2 },
  { id:"EURUSD", name:"EUR/USD", sub:"Euro/Dollar",  yahoo:"EURUSD=X",  digits:5 },
];
const YH_INT   = { "5min":"5m","15min":"15m","30min":"30m","1h":"60m","4h":"60m","1day":"1d" };
const YH_RANGE = { "5m":"1mo","15m":"1mo","30m":"2mo","60m":"3mo","1d":"2y" };
const HTF_UP   = { "5min":"1h","15min":"1h","30min":"4h","1h":"4h","4h":"1day","1day":"1day" };

/* ---------------- indicator math (identical to the app) ------------------ */
function ema(v,p){const o=Array(v.length).fill(null);if(v.length<p)return o;const k=2/(p+1);let s=0;for(let i=0;i<p;i++)s+=v[i];let pr=s/p;o[p-1]=pr;for(let i=p;i<v.length;i++){pr=v[i]*k+pr*(1-k);o[i]=pr;}return o;}
function rsi(c,p=14){const o=Array(c.length).fill(null);if(c.length<p+1)return o;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l-=d;}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1],gg=d>0?d:0,ll=d<0?-d:0;ag=(ag*(p-1)+gg)/p;al=(al*(p-1)+ll)/p;o[i]=al===0?100:100-100/(1+ag/al);}return o;}
function macd(c,f=12,s=26,sig=9){const ef=ema(c,f),es=ema(c,s);const line=c.map((_,i)=>(ef[i]!=null&&es[i]!=null)?ef[i]-es[i]:null);const valid=line.filter(x=>x!=null);const sv=ema(valid,sig);const fi=line.findIndex(x=>x!=null);const signal=Array(c.length).fill(null);for(let i=0;i<sv.length;i++)if(sv[i]!=null)signal[fi+i]=sv[i];const hist=line.map((x,i)=>(x!=null&&signal[i]!=null)?x-signal[i]:null);return{line,signal,hist};}
function atr(h,l,c,p=14){const tr=Array(c.length).fill(null),o=Array(c.length).fill(null);for(let i=0;i<c.length;i++)tr[i]=i===0?h[i]-l[i]:Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));if(c.length<p+1)return o;let s=0;for(let i=1;i<=p;i++)s+=tr[i];let pr=s/p;o[p]=pr;for(let i=p+1;i<c.length;i++){pr=(pr*(p-1)+tr[i])/p;o[i]=pr;}return o;}
function swing(h,l,lb=5){let hi=null,lo=null;for(let i=h.length-1-lb;i>lb;i--){if(hi==null){let ok=true;for(let j=1;j<=lb;j++)if(h[i]<h[i-j]||h[i]<h[i+j]){ok=false;break;}if(ok)hi=h[i];}if(lo==null){let ok=true;for(let j=1;j<=lb;j++)if(l[i]>l[i-j]||l[i]>l[i+j]){ok=false;break;}if(ok)lo=l[i];}if(hi!=null&&lo!=null)break;}return{hi,lo};}

/* ---------------- strategy (mirrors analyze() in the app) ---------------- */
function stateAt(series, i, htfSeries){
  const c=series.map(b=>b.c),h=series.map(b=>b.h),l=series.map(b=>b.l);
  const eF=ema(c,20),eS=ema(c,50),eT=ema(c,200),r=rsi(c,14),m=macd(c),a=atr(h,l,c,14),sw=swing(h.slice(0,i+1),l.slice(0,i+1),5);
  const px=c[i], ip=i-1, dir=v=>v>0?1:v<0?-1:0;
  if(eT[i]==null||a[i]==null||m.hist[i]==null||r[i]==null) return {state:"FLAT",confidence:0,px};

  let htfBias=0;
  if(htfSeries && htfSeries.length>200){
    const hc=htfSeries.map(b=>b.c); const hT=ema(hc,50),hTs=ema(hc,200); const j=hc.length-1;
    if(hT[j]!=null&&hTs[j]!=null) htfBias = hc[j]>hT[j]&&hT[j]>hTs[j]?1:(hc[j]<hT[j]&&hT[j]<hTs[j]?-1:0);
  } else {
    const slope=eT[i]-eT[Math.max(0,i-5)];
    htfBias = px>eT[i]&&slope>0?1:(px<eT[i]&&slope<0?-1:0);
  }

  const histRising=(m.hist[i]!=null&&m.hist[ip]!=null)?m.hist[i]-m.hist[ip]:0; void histRising;
  let rd=0; if(r[i]>=50&&r[i]<75)rd=1; else if(r[i]<=50&&r[i]>25)rd=-1;
  let sd=0; if(sw.hi!=null&&px>sw.hi)sd=1; else if(sw.lo!=null&&px<sw.lo)sd=-1;
  else if(sw.hi!=null&&sw.lo!=null)sd=dir(px-(sw.hi+sw.lo)/2);

  const F=[[htfBias,25],[dir(eF[i]-eS[i]),15],[dir(px-eT[i]),10],[dir(m.hist[i]),20],[rd,15],[sd,15]];
  const totalW=F.reduce((s,[,w])=>s+w,0);
  const net=F.reduce((s,[d,w])=>s+d*w,0);
  const direction=net>0?1:net<0?-1:0;
  const aligned=F.reduce((s,[d,w])=>s+(d===direction&&direction!==0?w:0),0);
  const confidence=direction===0?0:Math.round(aligned/totalW*100);

  let state="FLAT";
  if(direction!==0 && htfBias===direction && confidence>=THRESH) state=direction>0?"LONG":"SHORT";

  const risk=(a[i]||px*0.004)*ATR_MULT;
  const entry=px;
  const stop=direction>0?entry-risk:direction<0?entry+risk:entry-risk;
  const target=direction>0?entry+risk*2:direction<0?entry-risk*2:entry;
  return {state,direction,confidence,entry,stop,target,px};
}

/* ---------------- data (Yahoo, server-side = no CORS) -------------------- */
async function fetchYahoo(sym, tf){
  const iv=YH_INT[tf]||"15m";
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${YH_RANGE[iv]||"1mo"}`;
  const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 (SignalDesk cron)"}});
  const j=await r.json();
  const res=j?.chart?.result?.[0];
  if(!res?.timestamp) throw new Error(j?.chart?.error?.description||"no data");
  const q=res.indicators.quote[0], t=res.timestamp, out=[];
  for(let i=0;i<t.length;i++){ if(q.close[i]==null) continue;
    out.push({t:t[i]*1000,o:+q.open[i],h:+q.high[i],l:+q.low[i],c:+q.close[i]}); }
  return out;
}

/* ---------------- notifiers --------------------------------------------- */
const fmt=(v,d)=>Number(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
function message(inst, s){
  const emoji=s.state==="LONG"?"🟢":"🔴";
  return {
    title:`${emoji} ${s.state} · ${inst.name} (${TF})`,
    lines:[
      `Confluence ${s.confidence}%`,
      `Entry ${fmt(s.entry,inst.digits)}  |  Stop ${fmt(s.stop,inst.digits)}  |  2R ${fmt(s.target,inst.digits)}`,
      new Date().toUTCString(),
    ],
  };
}
async function sendTelegram(msg){
  const token=process.env.TELEGRAM_BOT_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat) return;
  const text=`<b>${msg.title}</b>\n`+msg.lines.join("\n");
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chat,text,parse_mode:"HTML",disable_web_page_preview:true}),
  }).catch(e=>console.warn("telegram send failed",e));
}
async function sendEmail(msg){
  const key=process.env.RESEND_API_KEY, to=process.env.ALERT_EMAIL_TO;
  if(!key||!to) return;
  const from=process.env.ALERT_EMAIL_FROM||"onboarding@resend.dev";
  const html=`<h3 style="margin:0 0 8px;font-family:system-ui">${msg.title}</h3>`+
             msg.lines.map(l=>`<div style="font-family:ui-monospace,monospace;color:#333">${l}</div>`).join("")+
             `<p style="color:#888;font-size:12px;font-family:system-ui;margin-top:12px">Signal Desk · research/education only, not financial advice.</p>`;
  await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},
    body:JSON.stringify({from,to,subject:msg.title,html}),
  }).catch(e=>console.warn("email send failed",e));
}

/* ---------------- main ---------------------------------------------------- */
export default async () => {
  const fired=[];
  for(const inst of INSTRUMENTS){
    try{
      const series=await fetchYahoo(inst.yahoo, TF);
      if(series.length<210) continue;
      let htf=null;
      if(USE_HTF){ try{ htf=await fetchYahoo(inst.yahoo, HTF_UP[TF]||TF); }catch{ htf=null; } }

      const n=series.length;
      // Use the last CLOSED bar (drop the possibly-forming final candle).
      const iNow=n-2, iPrev=n-3;
      const now=stateAt(series, iNow, htf);
      const prev=stateAt(series, iPrev, htf);

      // fresh transition into an actionable signal
      if(now.state!=="FLAT" && now.state!==prev.state){
        const msg=message(inst, now);
        await Promise.all([sendTelegram(msg), sendEmail(msg)]);
        fired.push(`${inst.name}:${now.state}@${now.confidence}%`);
      }
    }catch(e){ console.warn(`${inst.name} eval failed:`, e.message); }
  }
  const summary=fired.length?`sent ${fired.length}: ${fired.join(", ")}`:"no new signals";
  console.log("[signal-cron]", summary);
  return new Response(summary, {status:200});
};
