// netlify/functions/signals.mjs
// Serves the CURRENT signal per instrument for the MetaTrader EA (or anything) to poll.
// GET /.netlify/functions/signals            -> CSV  (easy to parse in MQL)
// GET /.netlify/functions/signals?format=json-> JSON
//
// CSV columns: instrument,state,entry,stop,target,confidence,tf,mode
//   e.g.        US30,LONG,39250.5,39010.2,39730.9,80,15min,trend
// state is LONG | SHORT | FLAT. The EA applies the STOP/TARGET *distances*
// (|entry-stop|, |target-entry|) to its own broker price, since the broker's
// symbol price differs slightly from this reference feed.
//
// Env: SIGNAL_TF (15min), CONF_THRESHOLD (60), ATR_MULT (1.5), USE_HTF (1),
//      MODE (trend | meanrev)

const TF       = process.env.SIGNAL_TF || "15min";
const THRESH   = +(process.env.CONF_THRESHOLD || 60);
const ATR_MULT = +(process.env.ATR_MULT || 1.5);
const USE_HTF  = (process.env.USE_HTF ?? "1") !== "0";
const MODE     = (process.env.MODE || "trend").toLowerCase();

const INSTRUMENTS = [
  { id:"US30",   yahoo:"YM=F",     digits:1 },  // Dow futures (continuous)
  { id:"NAS100", yahoo:"NQ=F",     digits:1 },  // Nasdaq-100 futures
  { id:"GOLD",   yahoo:"GC=F",     digits:2 },
  { id:"EURUSD", yahoo:"EURUSD=X", digits:5 },
];
const YH_INT   = { "5min":"5m","15min":"15m","30min":"30m","1h":"60m","4h":"60m","1day":"1d" };
const YH_RANGE = { "5m":"1mo","15m":"1mo","30m":"2mo","60m":"3mo","1d":"2y" };
const HTF_UP   = { "5min":"1h","15min":"1h","30min":"4h","1h":"4h","4h":"1day","1day":"1day" };

/* indicators (identical to the app) */
function ema(v,p){const o=Array(v.length).fill(null);if(v.length<p)return o;const k=2/(p+1);let s=0;for(let i=0;i<p;i++)s+=v[i];let pr=s/p;o[p-1]=pr;for(let i=p;i<v.length;i++){pr=v[i]*k+pr*(1-k);o[i]=pr;}return o;}
function rsi(c,p=14){const o=Array(c.length).fill(null);if(c.length<p+1)return o;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l-=d;}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1],gg=d>0?d:0,ll=d<0?-d:0;ag=(ag*(p-1)+gg)/p;al=(al*(p-1)+ll)/p;o[i]=al===0?100:100-100/(1+ag/al);}return o;}
function macd(c,f=12,s=26,sig=9){const ef=ema(c,f),es=ema(c,s);const line=c.map((_,i)=>(ef[i]!=null&&es[i]!=null)?ef[i]-es[i]:null);const valid=line.filter(x=>x!=null);const sv=ema(valid,sig);const fi=line.findIndex(x=>x!=null);const signal=Array(c.length).fill(null);for(let i=0;i<sv.length;i++)if(sv[i]!=null)signal[fi+i]=sv[i];const hist=line.map((x,i)=>(x!=null&&signal[i]!=null)?x-signal[i]:null);return{line,signal,hist};}
function atr(h,l,c,p=14){const tr=Array(c.length).fill(null),o=Array(c.length).fill(null);for(let i=0;i<c.length;i++)tr[i]=i===0?h[i]-l[i]:Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));if(c.length<p+1)return o;let s=0;for(let i=1;i<=p;i++)s+=tr[i];let pr=s/p;o[p]=pr;for(let i=p+1;i<c.length;i++){pr=(pr*(p-1)+tr[i])/p;o[i]=pr;}return o;}
function swing(h,l,lb=5){let hi=null,lo=null;for(let i=h.length-1-lb;i>lb;i--){if(hi==null){let ok=true;for(let j=1;j<=lb;j++)if(h[i]<h[i-j]||h[i]<h[i+j]){ok=false;break;}if(ok)hi=h[i];}if(lo==null){let ok=true;for(let j=1;j<=lb;j++)if(l[i]>l[i-j]||l[i]>l[i+j]){ok=false;break;}if(ok)lo=l[i];}if(hi!=null&&lo!=null)break;}return{hi,lo};}
function bollinger(c,p=20,k=2){const mid=Array(c.length).fill(null),up=Array(c.length).fill(null),lo=Array(c.length).fill(null);for(let i=p-1;i<c.length;i++){let s=0;for(let j=i-p+1;j<=i;j++)s+=c[j];const mn=s/p;let v=0;for(let j=i-p+1;j<=i;j++)v+=(c[j]-mn)*(c[j]-mn);const sd=Math.sqrt(v/p);mid[i]=mn;up[i]=mn+k*sd;lo[i]=mn-k*sd;}return{mid,up,lo};}

/* mode-aware evaluation on bar index i */
function stateAt(series, i, htfSeries){
  const c=series.map(b=>b.c),h=series.map(b=>b.h),l=series.map(b=>b.l);
  const a=atr(h,l,c,14), r=rsi(c,14), px=c[i], ip=i-1, dir=v=>v>0?1:v<0?-1:0;
  if(a[i]==null||r[i]==null) return {state:"FLAT",confidence:0,px};
  let direction=0, confidence=0;

  if(MODE==="meanrev"){
    const bb=bollinger(c,20,2), mid=bb.mid[i],upB=bb.up[i],loB=bb.lo[i],atrN=a[i];
    const f1=r[i]<30?1:(r[i]>70?-1:0);
    const f2=(loB!=null&&px<=loB)?1:((upB!=null&&px>=upB)?-1:0);
    const dm=mid!=null?px-mid:0, f3=(mid!=null&&Math.abs(dm)>atrN)?(dm<0?1:-1):0;
    const f4=(r[ip]!=null)?((r[ip]<35&&r[i]>r[ip])?1:((r[ip]>65&&r[i]<r[ip])?-1:0)):0;
    const f5=(loB!=null&&l[i]<loB&&c[i]>loB)?1:((upB!=null&&h[i]>upB&&c[i]<upB)?-1:0);
    const tot=100, net=f1*30+f2*25+f3*15+f4*15+f5*15;
    direction=net>0?1:net<0?-1:0;
    if(direction===0||(f1===0&&f2===0)) direction=0;
    else { const al=[[f1,30],[f2,25],[f3,15],[f4,15],[f5,15]].reduce((s,[d,w])=>s+(d===direction?w:0),0);
      confidence=Math.round(al/tot*100); if(confidence<THRESH) direction=0; }
  } else {
    const eF=ema(c,20),eS=ema(c,50),eT=ema(c,200),m=macd(c);
    if(eT[i]==null||m.hist[i]==null) return {state:"FLAT",confidence:0,px};
    let htfBias=0;
    if(htfSeries&&htfSeries.length>200){const hc=htfSeries.map(b=>b.c),hT=ema(hc,50),hTs=ema(hc,200),j=hc.length-1;
      if(hT[j]!=null&&hTs[j]!=null)htfBias=hc[j]>hT[j]&&hT[j]>hTs[j]?1:(hc[j]<hT[j]&&hT[j]<hTs[j]?-1:0);}
    else{const slope=eT[i]-eT[Math.max(0,i-5)];htfBias=px>eT[i]&&slope>0?1:(px<eT[i]&&slope<0?-1:0);}
    const rd=(r[i]>=50&&r[i]<75)?1:((r[i]<=50&&r[i]>25)?-1:0);
    const sw=swing(h.slice(0,i+1),l.slice(0,i+1),5);
    let sd=0; if(sw.hi!=null&&px>sw.hi)sd=1; else if(sw.lo!=null&&px<sw.lo)sd=-1; else if(sw.hi!=null&&sw.lo!=null)sd=dir(px-(sw.hi+sw.lo)/2);
    const F=[[htfBias,25],[dir(eF[i]-eS[i]),15],[dir(px-eT[i]),10],[dir(m.hist[i]),20],[rd,15],[sd,15]];
    const tot=F.reduce((s,[,w])=>s+w,0), net=F.reduce((s,[d,w])=>s+d*w,0);
    direction=net>0?1:net<0?-1:0;
    if(direction!==0 && htfBias===direction){ const al=F.reduce((s,[d,w])=>s+(d===direction?w:0),0); confidence=Math.round(al/tot*100); if(confidence<THRESH) direction=0; }
    else direction=0;
  }

  const risk=(a[i]||px*0.004)*ATR_MULT;
  const state = direction>0?"LONG":direction<0?"SHORT":"FLAT";
  const entry=px, stop=direction>0?entry-risk:direction<0?entry+risk:entry-risk,
        target=direction>0?entry+risk*2:direction<0?entry-risk*2:entry;
  return {state,direction,confidence,entry,stop,target,px};
}

async function fetchYahoo(sym, tf){
  const iv=YH_INT[tf]||"15m";
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${YH_RANGE[iv]||"1mo"}`;
  const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 (SignalDesk signals)"}});
  const j=await r.json(); const res=j?.chart?.result?.[0];
  if(!res?.timestamp) throw new Error("no data");
  const q=res.indicators.quote[0],t=res.timestamp,out=[];
  for(let i=0;i<t.length;i++){ if(q.close[i]==null) continue; out.push({t:t[i]*1000,o:+q.open[i],h:+q.high[i],l:+q.low[i],c:+q.close[i]}); }
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const fmt = url.searchParams.get("format") === "json" ? "json" : "csv";
  const rows = [];
  for(const inst of INSTRUMENTS){
    try{
      const series = await fetchYahoo(inst.yahoo, TF);
      if(series.length < 210){ rows.push({instrument:inst.id, state:"FLAT", entry:0, stop:0, target:0, confidence:0}); continue; }
      let htf=null; if(USE_HTF){ try{ htf=await fetchYahoo(inst.yahoo, HTF_UP[TF]||TF); }catch{} }
      const s = stateAt(series, series.length-2, htf); // last CLOSED bar
      rows.push({ instrument:inst.id, state:s.state,
        entry:+s.entry.toFixed(inst.digits), stop:+s.stop.toFixed(inst.digits),
        target:+s.target.toFixed(inst.digits), confidence:s.confidence });
    }catch(e){ rows.push({instrument:inst.id, state:"FLAT", entry:0, stop:0, target:0, confidence:0, error:String(e.message||e)}); }
  }
  const headers = { "Access-Control-Allow-Origin":"*", "Cache-Control":"no-store" };
  if(fmt==="json"){
    return new Response(JSON.stringify({ tf:TF, mode:MODE, generated:new Date().toISOString(), signals:rows }, null, 2),
      { status:200, headers:{ ...headers, "Content-Type":"application/json" } });
  }
  const csv = rows.map(r=>`${r.instrument},${r.state},${r.entry},${r.stop},${r.target},${r.confidence},${TF},${MODE}`).join("\n");
  return new Response(csv, { status:200, headers:{ ...headers, "Content-Type":"text/csv" } });
};
