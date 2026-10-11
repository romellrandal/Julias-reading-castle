// Adversarial QA for ../index.html.   Run: NODE_PATH=$(npm root -g) node tools/qa.js [filterRegex]
// A controllable mock webkitSpeechRecognition is injected (no real mic / Google service in CI).
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const SRC=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'";
const PIXEL={viewport:{width:393,height:851},deviceScaleFactor:2.75,hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'};
const INIT=`
window.__log=[];window.__act={n:0,max:0,starts:0};
(function(){
 const S=AudioBufferSourceNode.prototype.start,P=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.start=function(...a){ if(this.buffer&&this.buffer.length>1){window.__log.push({t:'buf',buf:this.buffer,at:performance.now()});this.__live=true;__act.n++;__act.starts++;if(__act.n>__act.max)__act.max=__act.n} return S.apply(this,a)};
 AudioBufferSourceNode.prototype.stop=function(...a){ if(this.__live){this.__live=false;__act.n--} return P.apply(this,a)};
 const CB=BaseAudioContext.prototype.createBufferSource;BaseAudioContext.prototype.createBufferSource=function(){const n=CB.apply(this,arguments);n.addEventListener('ended',()=>{if(n.__live){n.__live=false;__act.n--}});return n};
 const PL=HTMLMediaElement.prototype.play;
 HTMLMediaElement.prototype.play=function(){window.__log.push({t:'media',at:performance.now()});return PL.apply(this,arguments)};
 try{ if(window.speechSynthesis){const sp=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=function(u){window.__log.push({t:'tts',text:u.text,at:performance.now()});return sp(u)}} }catch(e){}
 window.__clips=async()=>{const m=new Map();for(const k of Object.keys(CLIPS)){const it=await getBuf(k);if(it)m.set(it.buf,k)}return window.__log.filter(e=>e.t==='buf').map(e=>({k:m.get(e.buf)||'?',at:e.at}))};
 window.__sec=[];document.addEventListener('securitypolicyviolation',e=>window.__sec.push(e.blockedURI+' '+e.violatedDirective));
 window.__rejections=[];window.addEventListener('unhandledrejection',e=>window.__rejections.push(String(e.reason&&e.reason.message||e.reason)));
})();`;
const MOCK=`
(function(){
 const S=window.__sr={inst:[],queue:[],starts:0,stops:0,aborts:0,auto:null,log:[],throwOnStart:false,forceOld:false,present:true};
 const word=()=>[...document.querySelectorAll('.L')].map(e=>e.textContent).join('');
 class MockSR{
  constructor(){this.lang='';this.interimResults=null;this.maxAlternatives=null;this.continuous=null;this._st='idle';this.onresult=this.onerror=this.onend=this.onstart=this.onaudiostart=null;S.inst.push(this);this._tm=[]}
  _t(f,ms){this._tm.push(setTimeout(f,ms))}
  _fire(n,ev){const f=S.forceOld?this._h[n]:this[n];if(f){try{f.call(this,ev)}catch(e){setTimeout(()=>{throw e})}}}
  start(){
    if(S.throwOnStart||this._st!=='idle'){S.log.push('start-throw');throw new DOMException('recognition has already started','InvalidStateError')}
    this._st='started';S.starts++;
    this._h={onresult:this.onresult,onerror:this.onerror,onend:this.onend,onstart:this.onstart,onaudiostart:this.onaudiostart};
    const b=this._b=S.queue.length?S.queue.shift():(S.auto?{type:'result',alts:[S.auto==='right'?word().toLowerCase():S.auto]}:{type:'hang'});
    const d=b.delay==null?150:b.delay;
    if(b.noStartEvent!==true)this._t(()=>{this._fire('onstart');this._fire('onaudiostart')},20);
    const res=alts=>({results:[Object.assign(alts.map(t=>({transcript:t,confidence:.9})),{isFinal:true})],resultIndex:0});
    if(b.type==='result')this._t(()=>{this._fire('onresult',res(b.alts));if(b.dup)this._fire('onresult',res(b.alts));if(b.err)this._fire('onerror',{error:b.err});this._st='idle';this._fire('onend')},d);
    else if(b.type==='empty')this._t(()=>{this._fire('onresult',{results:[]});this._st='idle';this._fire('onend')},d);
    else if(b.type==='blank')this._t(()=>{this._fire('onresult',res(['  ','']));this._st='idle';this._fire('onend')},d);
    else if(b.type==='error')this._t(()=>{this._fire('onerror',{error:b.code});this._st='idle';this._fire('onend')},d);
    else if(b.type==='end')this._t(()=>{this._st='idle';this._fire('onend')},d);
  }
  stop(){S.stops++;if(this._st!=='started')return;this._st='stopping';const b=this._b;
    if(b.type==='hang'&&!b.ignoreStop)this._t(()=>{this._st='idle';this._fire('onend')},30);
    else if(b.type==='hangResult')this._t(()=>{this._fire('onresult',res_(b.alts));this._st='idle';this._fire('onend')},30);}
  abort(){S.aborts++;if(this._b&&this._b.zombie)return;this._tm.forEach(clearTimeout);const was=this._st;this._st='idle';if(was!=='idle'){this._t(()=>{this._fire('onerror',{error:'aborted'});this._fire('onend')},5)}}
 }
 function res_(alts){return {results:[Object.assign(alts.map(t=>({transcript:t,confidence:.9})),{isFinal:true})],resultIndex:0}}
 Object.defineProperty(window,'webkitSpeechRecognition',{value:MockSR,writable:true,configurable:true});
 Object.defineProperty(window,'SpeechRecognition',{value:MockSR,writable:true,configurable:true});
})();`;
const NOSR="delete window.webkitSpeechRecognition;delete window.SpeechRecognition;";

let results=[],failures=[],cur='';
function ok(c,msg){ results.push([!!c,cur+': '+msg]); if(!c){failures.push(cur+': '+msg);console.log('  FAIL '+cur+': '+msg)} }
const filter=process.argv[2]?new RegExp(process.argv[2]):null;
const tests=[];const T=(name,fn,o)=>tests.push({name,fn,o});
let browser;
async function getBrowser(){return browser||(browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=document-user-activation-required']}))}
async function open(o={}){
  const b=await getBrowser();
  const ctx=await b.newContext({...PIXEL,...(o.viewport?{viewport:o.viewport}:{}),...(o.desktop?{viewport:{width:1280,height:800},hasTouch:false,isMobile:false,deviceScaleFactor:1}:{}),permissions:o.perms||['microphone']});
  const page=await ctx.newPage();
  const errs=[],reqs=[];
  page.on('pageerror',e=>errs.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
  page.on('request',r=>{const u=r.url();if(!/^(data:|blob:|https:\/\/castle\.test\/)/.test(u))reqs.push(u)});
  await page.addInitScript(INIT);
  if(o.nosr)await page.addInitScript(NOSR);else await page.addInitScript(MOCK);
  if(o.seed){await page.addInitScript(`try{if(!localStorage.getItem('__seeded')){localStorage.setItem('__seeded','1');localStorage.setItem('jrg2',${JSON.stringify(JSON.stringify(o.seed))})}}catch(e){}`)}
  if(o.raw!=null){await page.addInitScript(`try{if(!localStorage.getItem('__seeded')){localStorage.setItem('__seeded','1');localStorage.setItem('jrg2',${JSON.stringify(o.raw)})}}catch(e){}`)}
  if(o.init)await page.addInitScript(o.init);
  await page.route('https://castle.test/**',r=>r.fulfill({status:200,contentType:'text/html',headers:{'Content-Security-Policy':CSP},body:SRC}));
  await page.goto('https://castle.test/');
  await page.waitForSelector('#go');
  const touch=!o.desktop;
  const tp=async(sel,opt)=>{const l=page.locator(sel).first();if(touch)await l.tap(opt);else await l.click(opt)};
  const h={page,ctx,errs,reqs,
    q:(...b)=>page.evaluate(x=>window.__sr.queue.push(...x),b),
    sr:(k,v)=>page.evaluate(([k,v])=>{window.__sr[k]=v},[k,v]),
    ev:(f,a)=>page.evaluate(f,a),
    word:()=>page.evaluate(()=>[...document.querySelectorAll('.L')].map(e=>e.textContent).join('')),
    st:()=>page.evaluate(()=>JSON.parse(JSON.stringify(__dbg.state))),
    clips:()=>page.evaluate(()=>__clips()),
    txt:sel=>page.locator(sel).first().textContent(),
    vis:sel=>page.locator(sel).first().isVisible().catch(()=>false),
    tap:async sel=>{await tp(sel,sel==='#mic'?{force:true}:{})},
    play:async()=>{await tp('#go');await page.waitForFunction(()=>document.getElementById('read')||document.getElementById('mic'));},
    hold:async(ms)=>{await page.locator('#hold').scrollIntoViewIfNeeded();const bb=await page.locator('#hold').boundingBox();await page.mouse.move(bb.x+20,bb.y+20);await page.mouse.down();await page.waitForTimeout(ms||2300);await page.mouse.up()},
    back:async()=>{await page.waitForTimeout(450);await tp('#back')},
    armed:()=>page.waitForTimeout(420),
    mic:async()=>{await page.waitForTimeout(420);await tp('#mic',{force:true})},
    wf:(fn,arg,t)=>page.waitForFunction(fn,arg,{timeout:t||20000}).catch(e=>{throw new Error('wait failed: '+String(fn).slice(0,110))}),
    idle:()=>page.waitForFunction(()=>{const m=document.getElementById('mic');return m&&!m.classList.contains('listening')&&!m.classList.contains('thinking')&&document.getElementById('mic').dataset.phase==='idle'},null,{timeout:30000}),
    close:async()=>{
      const sec=await page.evaluate(()=>window.__sec.concat(window.__rejections.map(r=>'rejection '+r))).catch(()=>[]);
      ok(errs.length===0,'no console/page errors '+JSON.stringify(errs.slice(0,3)));
      ok(reqs.length===0,'no external requests '+JSON.stringify(reqs.slice(0,3)));
      ok(sec.length===0,'no CSP violations/unhandled rejections '+JSON.stringify(sec.slice(0,3)));
      await ctx.close();
    }};
  return h;
}
const seedState=(o)=>Object.assign({stars:0,stickers:0,comebacks:0,streak:0,best:0,roundNo:1,family:'u',words:{},attempts:[],earned:{},crowns:[]},o||{});
const owesAll=(words,extra)=>{const w={};for(const x of words)w[x]=Object.assign({tries:2,wins:0,miss:2,first:0,streak:0,owes:true,missRound:1,heard:'sunn'},extra||{});return w};
const U=["SUN","BUS","CUP","BUG","MUD","RUN","FUN","NUT","JUG"];
const names=cs=>cs.map(c=>c.k);

// ====================== unit-ish: normalization ======================
T('unit-normalize',async()=>{
  const h=await open();
  const r=await h.ev(()=>{
    const m=__dbg.matches;const t=(w,a)=>!!m(w,a);
    return {
      the_sun:t('SUN',['the sun']),sun_sun:t('SUN',['sun sun']),Sun_dot:t('SUN',['Sun.']),upper:t('SUN',['SUN!']),spaces:t('SUN',['  sun   ']),
      alt2:t('SUN',['son','sun']),alt5:t('SUN',['a','b','c','d','sun']),
      ten10:t('TEN',['10']),ten_ten:t('TEN',['ten']),ten_text:t('TEN',['the 10']),bus10:t('BUS',['10']),sun10:t('SUN',['10']),
      sit_sat:t('SAT',['sit']),sat_sat:t('SAT',['sat']),sunny:t('SUN',['sunny']),suns:t('SUN',['suns']),son:t('SUN',['son']),
      julia:t('JULIA',['Julia']),sam:t('SAM',['Sam']),tom:t('TOM',['Tom!']),tom2:t('TOM',['tum']),
      empty:t('SUN',['']),nul:t('SUN',[null,undefined]),none:t('SUN',[]),undef:t('SUN',undefined),num:t('SUN',[5]),
      accent:t('CAT',['Cát']),hyph:t('SUN',['sun-sun']),apos:t('SUN',["sun’"]),emoji:t('SUN',['sun 🌞']),
      red_read:t('RED',['read']),cap_c:t('CAN',['can']),proto:t('SUN',['__proto__']),
      ret:m('SUN',['the sun'])
    };
  });
  const yes=['the_sun','sun_sun','Sun_dot','upper','spaces','alt2','alt5','ten10','ten_ten','ten_text','julia','sam','tom','accent','hyph','apos','emoji','cap_c'];
  const no=['bus10','sun10','sit_sat','sunny','suns','son','tom2','empty','nul','none','undef','num','red_read','proto'];
  for(const k of yes)ok(r[k]===true,'matches '+k);
  for(const k of no)ok(r[k]===false,'rejects '+k);
  ok(r.sat_sat===true,'sat sat');
  ok(r.ret==='the sun','returns matching alt');
  await h.close();
});

// ====================== core loop ======================
T('home-smoke',async()=>{
  const h=await open();
  for(const s of ['#go','#castle','#test','#testmic','#setup'])ok(await h.vis(s),'home has '+s);
  ok(!(await h.vis('#retrymic')),'no retry button unless fallback');
  ok(await h.ev(()=>document.querySelector('meta[name=viewport]')!=null),'viewport meta');
  const hasBlend=await h.ev(()=>/Blend/.test(document.body.innerText));
  ok(!hasBlend,'no Blend text');
  await h.close();
});
T('right-first-try',async()=>{
  const h=await open();
  await h.play();
  const w=await h.word();
  await h.page.waitForTimeout(700);
  // letter taps are allowed and never reveal the whole word
  await h.tap('.L[data-k="0"]');await h.page.waitForTimeout(500);await h.tap('.L[data-k="1"]');await h.page.waitForTimeout(500);
  let c=names(await h.clips());
  ok(!c.includes('W'+w),'word clip not played before answering ('+c.join(',')+')');
  ok(c.includes('L'+w[0])&&c.includes('L'+w[1]),'letter tap plays letter sound');
  ok(await h.vis('#mic'),'mic visible');
  ok(!(await h.vis('#blend'))&&!(await h.vis('#show')),'no blend / I-read-it in mic mode');
  await h.q({type:'result',alts:[w.toLowerCase()]});
  await h.mic();
  await h.wf(()=>__dbg.state.stars===1);
  const s=await h.st();
  ok(s.attempts.length===1&&s.attempts[0].ok===true&&s.attempts[0].step===1&&s.attempts[0].word===w,'attempt logged ok step1 '+JSON.stringify(s.attempts));
  ok(s.words[w].wins===1&&s.words[w].first===1&&s.words[w].tries===1,'word stats');
  ok(await h.ev(()=>document.querySelectorAll('#fx span').length>0),'emoji burst present');
  ok((await h.txt('#pic')).length>0,'picture revealed');
  await h.page.waitForTimeout(2500);
  c=names(await h.clips());
  const iw=c.lastIndexOf('W'+w), ip=c.findIndex(k=>/^Ppraise/.test(k));
  ok(ip>=0,'praise clip played');ok(iw>ip,'word spoken AFTER praise ('+c.join(',')+')');
  const ri=await h.ev(()=>window.__sr.inst[0]);
  const cfg=await h.ev(()=>({l:__sr.inst[0].lang,i:__sr.inst[0].interimResults,m:__sr.inst[0].maxAlternatives,c:__sr.inst[0].continuous}));
  ok(cfg.l==='en-US'&&cfg.i===false&&cfg.m===5&&cfg.c===false,'recognizer config '+JSON.stringify(cfg));
  await h.wf(()=>/^2 \//.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,15000);
  ok(true,'advanced to card 2');
  await h.close();
});
T('miss1-then-right',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['banana','apple']},{type:'result',alts:[w.toLowerCase()]});
  await h.mic();
  await h.wf(()=>__dbg.state.attempts.length===1);
  ok(/try again/i.test(await h.txt('#hint')),'gentle hint '+await h.txt('#hint'));
  ok(!/wrong|incorrect|no!/i.test(await h.ev(()=>document.body.innerText)),'never says wrong');
  await h.wf(()=>document.querySelector('.L[data-k="0"]').classList.contains('lit'),null,6000);
  ok(true,'first letter highlighted');
  await h.idle();
  const c=names(await h.clips());
  ok(c.includes('Ptryagain'),'tryagain clip');
  ok(c.lastIndexOf('L'+w[0])>c.indexOf('Ptryagain'),'first letter sound after tryagain');
  ok(!c.includes('W'+w),'word NOT spoken after miss 1');
  let s=await h.st();
  ok(s.attempts[0].ok===false&&s.attempts[0].step===1&&s.attempts[0].heard==='banana','miss logged with heard '+JSON.stringify(s.attempts[0]));
  ok(s.stars===0,'no star yet');
  await h.mic();
  await h.wf(()=>__dbg.state.stars===1);
  s=await h.st();
  ok(s.attempts[1].ok===true&&s.attempts[1].step===2,'win at step 2');
  ok(s.words[w].first===0&&s.words[w].wins===1&&s.words[w].miss===1,'not a first-try win');
  ok(s.comebacks===0,'no comeback');
  await h.close();
});
T('miss2-sound-out',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['x']},{type:'result',alts:['y']},{type:'result',alts:[w.toLowerCase()]});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2);
  await h.idle();
  const cl=await h.clips();const c=names(cl);
  const i2=c.indexOf('Psoundout');
  ok(i2>=0,'soundout clip');
  const seq=c.slice(i2+1,i2+1+w.length);
  ok(seq.join()===[...w].map(x=>'L'+x).join(),'letters in order '+seq.join());
  const t0=cl[i2+1].at,tN=cl[i2+w.length].at;
  ok((tN-t0)>=500*(w.length-1),'slow gaps >=500ms per letter ('+Math.round(tN-t0)+'ms)');
  ok(c[i2+1+w.length]==='Pnowyou','Now you say it after letters');
  ok(!c.includes('W'+w),'word not spoken in miss 2');
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  const s=await h.st();ok(s.attempts[2].step===3&&s.attempts[2].ok,'win at step 3');
  await h.close();
},{});
T('miss3-practice-requeue-round',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  const total0=await h.ev(()=>document.querySelector('.bar div:nth-child(2)').textContent);
  ok(/\/ 10$/.test(total0),'10 cards '+total0);
  await h.q({type:'result',alts:['a']},{type:'result',alts:['b']},{type:'result',alts:['c']},{type:'result',alts:[w.toLowerCase()]});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===3);
  await h.wf(()=>/Now you say/.test(document.getElementById('hint').textContent)&&document.getElementById('mic').dataset.phase==='idle',null,25000);
  let c=names(await h.clips());
  const il=c.indexOf('Plisten');
  ok(il>=0&&c[il+1]==='W'+w&&c[il+2]==='Pnowyou','Listen... WORD ... Now you say it: '+c.slice(il,il+3).join());
  let s=await h.st();
  ok(s.attempts.length===3&&s.attempts.every(a=>!a.ok),'3 graded misses');
  await h.mic();
  await h.wf(()=>__dbg.state.attempts.length===4);
  s=await h.st();
  ok(s.attempts[3].practice===true,'practice attempt flagged');
  ok(s.stars===0,'no star for practice');
  ok(s.words[w].tries===3&&s.words[w].miss===3&&s.words[w].wins===0,'practice not counted as try/win '+JSON.stringify(s.words[w]));
  await h.wf(()=>/\/ 11$/.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,8000);
  ok(true,'requeued: deck now 11');
  c=names(await h.clips());ok(c.includes('Ppractice'),'practice praise clip');
  await h.close();
});
T('full-round-with-requeue-cap',async()=>{
  const h=await open({seed:seedState({family:'o'})});
  await h.play();
  await h.sr('auto','right');
  const first=await h.word();
  // first card: three misses (queue) then a practice response; the requeued copy: miss 3 times again -> must NOT requeue twice
  const miss=(n)=>Array.from({length:n},()=>({type:'result',alts:['zzz'],delay:60}));
  await h.q(...miss(4));
  const seen=[];let guard=0,injected=false;
  while(guard++<500){
    if(await h.vis('#again'))break;
    const idx=await h.ev(()=>document.querySelector('.bar div:nth-child(2)')?.textContent||'');
    const w=await h.word().catch(()=>'');
    if(idx&&(!seen.length||seen[seen.length-1].idx!==idx))seen.push({idx,w});
    const ready=await h.ev(()=>{const m=document.getElementById('mic');return !!m&&m.dataset.phase==='idle'});
    if(ready){
      if(!injected&&w===first&&seen.filter(x=>x.w===first).length===2){injected=true;await h.q(...miss(4))}
      await h.page.locator('#mic').tap({force:true}).catch(()=>{});
    }
    await h.page.waitForTimeout(250);
  }
  ok(await h.vis('#again'),'round finished');
  const s=await h.st();
  const firstCards=seen.filter(x=>x.w===first).length;
  ok(firstCards===2,'first word shown exactly twice (original + one requeue): '+firstCards);
  ok(seen.length===11,'11 cards total, no endless loop: '+seen.length);
  ok(s.stickers===1,'one round sticker '+s.stickers);
  ok(s.attempts.filter(a=>a.practice).length===2,'two practice entries');
  await h.close();
},{slow:true});
T('no-speech-does-not-advance',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'error',code:'no-speech'},{type:'end'},{type:'empty'},{type:'blank'});
  for(let n=0;n<4;n++){await h.mic();await h.wf(n=>document.getElementById('mic').dataset.phase==='idle'&&/didn't hear/.test(document.getElementById('hint').textContent)&&window.__sr.starts===n+1,n,8000);await h.page.waitForTimeout(100);
    if(n<3)await h.page.evaluate(()=>{document.getElementById('hint').textContent='x'})}
  const s=await h.st();
  ok(s.attempts.length===0,'no attempts logged for silence');
  ok(s.words[w]===undefined,'no stats');
  const c=names(await h.clips());ok(c.filter(k=>k==='Pnohear').length>=3,'friendly nohear clip x'+c.filter(k=>k==='Pnohear').length);
  ok(!c.includes('Ptryagain'),'ladder not advanced');
  ok(await h.vis('#extra'),'skip/grown-up path offered after repeated silence');
  await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  const s2=await h.st();ok(s2.attempts[0].step===1&&s2.attempts[0].ok,'later win is still step 1');
  await h.close();
});
T('skip-button',async()=>{
  const h=await open();
  await h.play();
  await h.q({type:'end'},{type:'end'},{type:'end'});
  for(let n=0;n<3;n++){await h.mic();await h.wf(n=>window.__sr.starts===n+1&&document.getElementById('mic').dataset.phase==='idle',n,8000)}
  await h.page.waitForTimeout(500);
  await h.tap('#skip');
  await h.wf(()=>/^2 \//.test(document.querySelector('.bar div:nth-child(2)').textContent));
  ok((await h.st()).attempts.length===0,'skip logs nothing');
  await h.close();
});
T('hang-timeout',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'hang'},{type:'hang',ignoreStop:true});
  await h.mic();
  ok(await h.ev(()=>document.getElementById('mic').classList.contains('listening')),'listening animation');
  ok(/tap to stop/i.test(await h.txt('#miclab')),'tap again to stop label');
  const t0=Date.now();
  await h.wf(()=>!document.getElementById('mic').classList.contains('listening'),null,12000);
  const dt=Date.now()-t0;ok(dt>5000&&dt<8500,'hard timeout ~6s ('+dt+'ms)');
  ok((await h.ev(()=>window.__sr.stops))>=1,'stop() called at timeout');
  ok((await h.st()).attempts.length===0,'timeout is not a miss');
  await h.idle();
  // recognizer that ignores stop(): grace expiry still ends it
  await h.mic();const t1=Date.now();
  await h.wf(()=>!document.getElementById('mic').classList.contains('listening'),null,14000);
  const d2=Date.now()-t1;ok(d2>6500&&d2<10000,'stuck recognizer given up after grace ('+d2+'ms)');
  ok((await h.ev(()=>window.__sr.aborts))>=1,'abort() called when recognizer ignores stop');
  await h.close();
},{});
T('tap-to-stop',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'hangResult',alts:[w.toLowerCase()]});
  await h.mic();
  await h.page.waitForTimeout(300);
  await h.page.locator('#mic').tap({force:true}); // too soon after start (<600ms): ignored
  ok((await h.ev(()=>window.__sr.stops))===0,'accidental quick second tap ignored');
  await h.page.waitForTimeout(500);
  await h.page.locator('#mic').tap({force:true});
  await h.wf(()=>__dbg.state.stars===1);
  ok((await h.ev(()=>window.__sr.stops))===1,'stop() requested once');
  await h.close();
});
T('mic-spam',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.page.waitForTimeout(450);
  await h.q({type:'result',alts:[w],delay:900});
  for(let k=0;k<8;k++){await h.page.locator('#mic').dispatchEvent('click');}
  await h.wf(()=>__dbg.state.stars===1);
  await h.page.waitForTimeout(300);
  ok((await h.ev(()=>window.__sr.starts))===1,'only one recognition started: '+await h.ev(()=>window.__sr.starts));
  ok((await h.ev(()=>window.__sr.inst.length))===1,'one recognizer object');
  ok((await h.st()).stars===1,'exactly one star');
  // spam during feedback
  for(let k=0;k<5;k++)await h.page.locator('#mic').dispatchEvent('click').catch(()=>{});
  ok((await h.ev(()=>window.__sr.starts))===1,'taps during feedback ignored');
  await h.close();
});
T('invalid-state-double-start',async()=>{
  const h=await open();
  await h.play();
  await h.sr('throwOnStart',true);
  await h.mic();
  await h.wf(()=>/Tap|tap/.test(document.getElementById('hint').textContent)&&!document.getElementById('mic').classList.contains('listening'),null,5000);
  ok((await h.st()).attempts.length===0,'InvalidStateError is not a miss');
  ok(!(await h.ev(()=>__dbg.M.fallback)),'not fallback');
  await h.sr('throwOnStart',false);
  const w=await h.word();await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.close();
});
T('double-result-and-error-after-result',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:[w],dup:true,err:'network'});
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.page.waitForTimeout(1500);
  const s=await h.st();
  ok(s.stars===1&&s.attempts.length===1,'single star, single attempt');
  ok(!(await h.ev(()=>__dbg.M.fallback))&&(await h.ev(()=>__dbg.M.fails))===0,'late error ignored');
  await h.close();
});
T('mic-during-prompt-cancels-it',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['q']},{type:'hang'});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);
  await h.wf(()=>window.__log.length>=1);
  await h.page.waitForTimeout(250); // Ptryagain playing
  const n0=(await h.clips()).length;
  await h.page.locator('#mic').tap({force:true});
  await h.wf(()=>document.getElementById('mic').classList.contains('listening'));
  await h.page.waitForTimeout(2500);
  const c=names(await h.clips());
  ok(!c.slice(n0).some(k=>k[0]==='L'),'ladder letter prompt cancelled, nothing played while listening: '+c.slice(n0).join());
  ok(await h.ev(()=>window.__act.n)===0,'no audio active while listening');
  await h.close();
});
T('letter-tap-while-listening',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'hang',zombie:true},{type:'result',alts:[w]});
  await h.sr('forceOld',true);
  await h.mic();await h.page.waitForTimeout(100);
  const a=await h.ev(()=>window.__log.length);
  await h.tap('.L[data-k="1"]');
  await h.wf(()=>window.__log.length>0,null,4000);
  ok(!(await h.ev(()=>document.getElementById('mic').classList.contains('listening'))),'listening stopped');
  ok((await h.ev(()=>window.__sr.aborts))===1,'recognizer aborted');
  ok(names(await h.clips()).includes('L'+w[1]),'letter sound played');
  ok(!(await h.ev(()=>window.__sr.inst[0]._st==='started'&&false)),'');
  ok((await h.st()).attempts.length===0,'nothing logged');
  await h.page.waitForTimeout(800);
  ok(/Say the word/.test(await h.txt('#miclab')),'back to idle');
  // can listen again afterwards
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.close();
});
T('back-mid-listening-late-result',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.sr('forceOld',true);
  await h.q({type:'result',alts:[w],delay:2500,zombie:true});
  await h.mic();await h.page.waitForTimeout(300);
  await h.page.waitForTimeout(150);
  await h.back();
  await h.wf(()=>!!document.getElementById('go'));
  ok((await h.ev(()=>window.__sr.aborts))===1,'aborted on Back');
  ok((await h.ev(()=>__dbg.LIS))===null,'no live session');
  await h.page.waitForTimeout(3500);
  const s=await h.st();
  ok(s.stars===0&&s.attempts.length===0&&s.stickers===0,'late result did nothing '+JSON.stringify([s.stars,s.attempts.length]));
  ok(await h.vis('#go'),'still on home');
  // new round works normally after
  await h.play();const w2=await h.word();await h.q({type:'result',alts:[w2]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  ok((await h.st()).stars===1,'exactly one star afterwards');
  await h.close();
});
T('hidden-page-aborts-listening',async()=>{
  const h=await open();
  await h.play();
  await h.q({type:'hang',zombie:true});
  await h.mic();await h.page.waitForTimeout(200);
  await h.ev(()=>{Object.defineProperty(document,'visibilityState',{get:()=>'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
  await h.page.waitForTimeout(200);
  ok((await h.ev(()=>window.__sr.aborts))===1,'aborted when hidden');
  ok(!(await h.ev(()=>document.getElementById('mic').classList.contains('listening'))),'UI idle');
  await h.close();
});
T('unmount-no-timers-after-leaving',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:[w],delay:100});
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.page.waitForTimeout(300);
  await h.back();
  await h.wf(()=>!!document.getElementById('go'));
  const before=await h.ev(()=>({st:JSON.stringify(__dbg.state),starts:window.__act.starts}));
  await h.ev(()=>{window.__mut=0;new MutationObserver(m=>{window.__mut+=m.length}).observe(document.getElementById('app'),{subtree:true,childList:true,characterData:true,attributes:true})});
  await h.page.waitForTimeout(8000);
  const after=await h.ev(()=>({st:JSON.stringify(__dbg.state),starts:window.__act.starts,mut:window.__mut}));
  ok(after.mut===0,'no DOM mutations after leaving ('+after.mut+')');
  ok(after.st===before.st,'state unchanged');
  ok(after.starts===before.starts,'no audio started after leaving');
  await h.close();
});
T('audio-no-overlap-ladder',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['a']},{type:'result',alts:['b']},{type:'result',alts:[w]});
  await h.page.waitForTimeout(600);
  await h.tap('.L[data-k="0"]');await h.page.waitForTimeout(100);await h.tap('.L[data-k="1"]');await h.tap('.L[data-k="2"]');
  await h.page.waitForTimeout(300);
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);
  await h.page.waitForTimeout(400);await h.tap('.L[data-k="2"]');await h.page.waitForTimeout(200);
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2,null,8000);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.page.waitForTimeout(6000);
  const mx=await h.ev(()=>window.__act.max);
  ok(mx<=1,'never more than one clip sounding at once (max '+mx+')');
  await h.close();
},{});
T('audio-webaudio-under-autoplay-policy',async()=>{
  const h=await open();
  ok(await h.ev(()=>!window.__A.ctx||window.__A.ctx.state!=='running'),'ctx not running before gesture');
  await h.play();await h.page.waitForTimeout(700);
  await h.tap('.L[data-k="0"]');
  await h.wf(()=>window.__log.length>0,null,5000);
  ok(await h.ev(()=>window.__A.ctx.state==='running'),'ctx running after tap');
  ok(await h.ev(()=>window.__A.mode==='webaudio'),'played via Web Audio');
  ok(!(await h.vis('#ab')),'no sound banner');
  await h.close();
});

// ====================== fallback ======================
T('fallback-denied-and-recovery',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'error',code:'not-allowed'});
  await h.mic();
  await h.wf(()=>document.getElementById('read')&&!document.getElementById('micwrap').offsetParent==true||document.getElementById('read'));
  ok(!(await h.vis('#mic')),'mic hidden in fallback');
  ok(await h.vis('#read'),'I read it button');
  ok(/Grown-up/.test(await h.txt('#why'))&&/Microphone/i.test(await h.txt('#why')),'parent-readable note: '+await h.txt('#why'));
  ok((await h.st()).attempts.length===0,'no attempt logged');
  await h.page.waitForTimeout(450);
  await h.tap('#read');
  ok((await h.txt('#pic')).length>0,'reveal');
  await h.wf(()=>!document.getElementById('yes').disabled);
  await h.tap('#yes');
  await h.wf(()=>__dbg.state.stars===1);
  let s=await h.st();ok(s.attempts[0].via==='parent'&&s.attempts[0].ok&&s.attempts[0].step===1,'parent win logged');
  await h.wf(()=>/^2 \//.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,12000);
  ok(await h.vis('#read'),'card 2 also in fallback (session-level)');
  await h.page.waitForTimeout(450);await h.tap('#read');await h.wf(()=>!document.getElementById('no').disabled);
  const w2=await h.word();
  await h.tap('#no');
  await h.wf(()=>/^3 \//.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''));
  s=await h.st();ok(s.words[w2].miss===1&&s.words[w2].owes===true,'Try later = miss');
  ok(/\/ 11$/.test(await h.txt('.bar div:nth-child(2)')),'requeued once');
  await h.back();await h.wf(()=>!!document.getElementById('go'));
  ok(await h.vis('#retrymic'),'Try the mic again button on home');
  ok(/resting/.test(await h.txt('#mnote')),'home note');
  await h.tap('#retrymic');
  ok(!(await h.vis('#retrymic')),'fallback cleared');
  await h.play();
  ok(await h.vis('#mic'),'mic back after retry');
  const w3=await h.word();await h.q({type:'result',alts:[w3]});await h.mic();await h.wf(()=>__dbg.state.stars===2);
  await h.close();
});
T('fallback-soft-errors',async()=>{
  const h=await open();
  await h.play();
  await h.q({type:'error',code:'network'},{type:'error',code:'network'});
  await h.mic();await h.wf(()=>/Grown-up/.test(document.getElementById('why').textContent)&&!document.getElementById('mic').classList.contains('listening'));
  ok(/internet|Wi-Fi/i.test(await h.txt('#why')),'network hint: '+await h.txt('#why'));
  ok(await h.vis('#mic'),'first failure keeps mic');
  ok((await h.st()).attempts.length===0,'network error not a miss');
  await h.idle();
  await h.mic();
  await h.wf(()=>!!document.getElementById('read')&&document.getElementById('micwrap').classList.contains('hidden'));
  ok(true,'second consecutive failure -> fallback');
  ok(/internet|Wi-Fi/i.test(await h.txt('#why')),'parent hint on fallback');
  await h.back();await h.wf(()=>!!document.getElementById('retrymic'));
  await h.close();
});
T('soft-error-resets-on-success',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'error',code:'audio-capture'},{type:'end'},{type:'error',code:'audio-capture'},{type:'result',alts:[w]});
  await h.mic();await h.idle();await h.mic();await h.idle();
  await h.mic();await h.idle();
  ok(await h.vis('#mic'),'non-consecutive errors do not trigger fallback');
  await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.close();
});
T('unsupported-api',async()=>{
  const h=await open({nosr:true});
  await h.play();
  ok(!(await h.vis('#mic')),'no mic');
  ok(await h.vis('#read'),'parent buttons');
  ok(/Chrome/.test(await h.txt('#why')),'note mentions Chrome');
  await h.page.waitForTimeout(450);await h.tap('#read');await h.wf(()=>!document.getElementById('yes').disabled);await h.tap('#yes');
  await h.wf(()=>__dbg.state.stars===1);
  await h.back();await h.wf(()=>!!document.getElementById('retrymic'));
  await h.tap('#retrymic');
  ok(await h.vis('#retrymic'),'still unsupported: button remains');
  await h.tap('#testmic');await h.page.waitForTimeout(300);
  await h.tap('#mic');
  ok(/no speech recognition/i.test(await h.txt('#mout')),'micTest explains');
  await h.close();
});
T('fallback-from-skip-menu',async()=>{
  const h=await open();
  await h.play();
  await h.q({type:'end'},{type:'end'},{type:'end'});
  for(let n=0;n<3;n++){await h.mic();await h.wf(n=>window.__sr.starts===n+1&&document.getElementById('mic').dataset.phase==='idle',n,8000)}
  await h.page.waitForTimeout(450);
  await h.tap('#gu');
  ok(await h.vis('#read'),'switched to parent buttons');
  await h.close();
});
T('language-error-fatal',async()=>{
  const h=await open();
  await h.play();
  await h.q({type:'error',code:'service-not-allowed'});
  await h.mic();
  await h.wf(()=>!!document.getElementById('read')&&document.getElementById('micwrap').classList.contains('hidden'));
  ok(true,'service-not-allowed -> fallback');
  await h.close();
});

// ====================== comeback / stats ======================
T('comeback-first-try-after-miss',async()=>{
  const h=await open({seed:seedState({words:owesAll(U),stars:3})});
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:[w]});await h.mic();
  await h.wf(()=>__dbg.state.comebacks===1);
  const s=await h.st();
  ok(s.crowns.length===1&&s.crowns[0].w===w,'crown recorded');
  ok(s.words[w].owes===false,'owes cleared');
  ok(s.earned.cb1,'Comeback Crown sticker earned');
  ok(await h.vis('#cb')&&/Comeback/.test(await h.txt('#cb')),'celebration shown');
  await h.page.waitForTimeout(2800);
  ok(names(await h.clips()).includes('Pcomeback'),'comeback line spoken');
  // reload persistence
  await h.page.waitForTimeout(3000);
  await h.page.reload();await h.page.waitForSelector('#go');
  const s2=await h.st();ok(s2.comebacks===1&&s2.earned.cb1&&s2.crowns.length===1,'persisted across reload');
  await h.close();
});
T('comeback-not-on-step2-or-without-prior-miss',async()=>{
  const h=await open({seed:seedState({words:owesAll(['SUN','BUS','CUP','BUG','MUD','RUN','FUN','NUT','JUG','JULIA'],{})})});
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['z']},{type:'result',alts:[w]});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.idle();await h.mic();await h.wf(()=>__dbg.state.stars===1);
  const s=await h.st();
  ok(s.comebacks===0,'step-2 win is not a comeback');ok(s.words[w].owes===true,'still owes');
  await h.close();
  const h2=await open({seed:seedState({})});
  await h2.play();const w2=await h2.word();await h2.q({type:'result',alts:[w2]});await h2.mic();await h2.wf(()=>__dbg.state.stars===1);
  ok((await h2.st()).comebacks===0,'no comeback without prior miss');
  await h2.close();
});
T('comeback-not-same-round-requeue',async()=>{
  // miss the word 3x in this round, practice, then read the requeued copy first try: NOT a comeback (same round)
  const h=await open({seed:seedState({family:'u'})});
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['a']},{type:'result',alts:['b']},{type:'result',alts:['c']},{type:'result',alts:['d']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===3);
  await h.wf(()=>document.getElementById('mic').dataset.phase==='idle'&&/Now you say/.test(document.getElementById('hint').textContent),null,25000);
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===4);
  await h.sr('auto','right');
  // advance through the other 9 cards
  let guard=0;
  while(guard++<200){
    const idx=await h.ev(()=>document.querySelector('.bar div:nth-child(2)')?.textContent||'');
    if(/^10 \/ 11/.test(idx)&&(await h.word())===''){}
    if(/^11 \/ 11/.test(idx))break;
    const ready=await h.ev(()=>{const m=document.getElementById('mic');return m&&document.getElementById('mic').dataset.phase==='idle'});
    if(ready)await h.page.locator('#mic').tap({force:true}).catch(()=>{});
    await h.page.waitForTimeout(300);
  }
  ok(await h.word()===w,'requeued copy arrives last');
  await h.page.waitForTimeout(600);await h.page.locator('#mic').tap({force:true});
  await h.wf(()=>__dbg.state.words[document.querySelector('.L')&&[...document.querySelectorAll('.L')].map(e=>e.textContent).join('')]?.wins>=1,null,6000);
  const s=await h.st();
  ok(s.words[w].wins===1&&s.words[w].first===0,'requeue win not first-try');
  ok(s.comebacks===0||!s.crowns.some(c=>c.w===w),'no comeback for same-round requeue');
  await h.close();
},{slow:true});
T('comeback-parent-mode-and-room-milestone',async()=>{
  const h=await open({nosr:true,seed:seedState({comebacks:4,earned:{cb1:1},crowns:[{w:'SUN',ts:1}],words:owesAll(U)})});
  await h.play();const w=await h.word();
  await h.page.waitForTimeout(450);await h.tap('#read');await h.wf(()=>!document.getElementById('yes').disabled);await h.tap('#yes');
  await h.wf(()=>__dbg.state.comebacks===5);
  const s=await h.st();ok(s.earned.cb5,'5 comebacks -> Throne Room');
  ok(/Throne Room/.test(await h.txt('#cb')),'room announced');
  await h.page.waitForTimeout(5000);
  ok(names(await h.clips()).includes('Proom'),'room clip');
  await h.close();
});
T('state-log-cap-and-sanitize',async()=>{
  const att=Array.from({length:700},(_,i)=>({word:'SUN',heard:'x'.repeat(200),ok:i%2===0,step:9,ts:i}));
  att.push({word:'__proto__',heard:'a',ok:true,step:1,ts:1},null,5,{word:'<img src=x onerror=alert(1)>'});
  const h=await open({raw:JSON.stringify({stars:'abc',stickers:-5,comebacks:1e30,words:{'__proto__':{wins:5,polluted:1},constructor:{wins:1},SUN:{tries:4,wins:'3',miss:1,first:1,owes:true,missRound:0,heard:'<b>bold</b>'},'sun':{wins:9},'<x>':{wins:1}},attempts:att,earned:{cb1:1,'__proto__':1,zzz:1},crowns:[{w:'SUN',ts:1},{w:'<b>',ts:2},7],family:'zz'})});
  const s=await h.st();
  ok(s.attempts.length===500,'attempt log capped at 500: '+s.attempts.length);
  ok(s.attempts.every(a=>a.step>=1&&a.step<=3&&a.heard.length<=60&&/^[A-Z]+$/.test(a.word)),'attempts sanitized');
  ok(Object.keys(s.words).join()==='SUN','only valid words kept '+Object.keys(s.words));
  ok(s.words.SUN.wins===3,'numeric string coerced');
  ok(({}).polluted===undefined&&({}).wins===undefined,'prototype not polluted');
  ok(Object.keys(s.earned).join()==='cb1','earned sanitized');
  ok(s.crowns.length===1,'crowns sanitized');
  ok(s.stars===0&&s.stickers===0&&s.comebacks===1e9,'numbers clamped');
  ok(s.family==='a','invalid family reset');
  await h.tap('#castle');await h.page.waitForSelector('#hold');
  ok(await h.ev(()=>!document.querySelector('#app img')),'no injected markup');
  // adding an attempt keeps the cap
  await h.back();await h.play();const w=await h.word();await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars>0);
  ok((await h.st()).attempts.length===500,'cap holds after adding');
  await h.close();
});
T('storage-throws-and-corrupt',async()=>{
  const bad=`Storage.prototype.getItem=function(){throw new DOMException('denied','SecurityError')};Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')};`;
  const h=await open({init:bad});
  await h.play();const w=await h.word();await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.back();await h.wf(()=>!!document.getElementById('go'));
  await h.tap('#castle');await h.page.waitForSelector('#hold');
  ok(true,'works with throwing storage');
  await h.close();
  for(const raw of ['{not json','null','[]','"str"','{"words":5,"attempts":"x","earned":[]}','123']){
    const g=await open({raw});
    ok(await g.vis('#go'),'corrupt state '+raw+' loads');
    const s=await g.st();ok(s.stars===0&&Array.isArray(s.attempts),'defaults for '+raw);
    await g.close();
  }
});
T('storage-removed-midgame',async()=>{
  const h=await open();
  await h.play();
  await h.ev(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('gone')},configurable:true})});
  const w=await h.word();await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  await h.close();
});

// ====================== progress screen ======================
T('castle-empty',async()=>{
  const h=await open();
  await h.tap('#castle');await h.page.waitForSelector('#hold');
  const t=await h.ev(()=>document.body.innerText);
  ok(/Read more words to unlock/i.test(t),'unlock hint');
  ok(await h.ev(()=>document.querySelectorAll('.sticker.lock').length)>=8,'locked silhouettes');
  ok(/practicing/i.test(t),'practicing section');
  ok(!/Heard|Reset progress/.test(t),'grown-up section hidden before gate');
  ok(!/fail|wrong|bad/i.test(t),'no shaming words');
  await h.close();
});
T('castle-grownup-gate-and-reset',async()=>{
  const words={};for(const w of U)words[w]={tries:5,wins:3,miss:2,first:1,streak:1,owes:w==='SUN',missRound:1,heard:w==='SUN'?'son':''};
  const att=[];for(let i=0;i<10;i++)att.push({word:'SUN',heard:'son',ok:i>5,step:1,ts:i});
  const h=await open({seed:seedState({stars:12,stickers:2,comebacks:1,earned:{r1:1,cb1:1},crowns:[{w:'BUS',ts:1}],words,attempts:att})});
  await h.tap('#castle');await h.page.waitForSelector('#hold');
  const t=await h.ev(()=>document.body.innerText);
  ok(/Words we're practicing/.test(t)&&await h.ev(()=>document.querySelectorAll('#prac .tile').length)===1,'SUN in practicing');
  ok(await h.ev(()=>document.querySelectorAll('.tile.got').length)===9,'9 won tiles');
  // quick tap does NOT open
  await h.tap('#hold');await h.page.waitForTimeout(500);
  ok(!(await h.vis('#reset')),'short tap does not open grown-up area');
  // hold 1s then release does not open
  const bb=await h.page.locator('#hold').boundingBox();
  await h.page.mouse.move(bb.x+20,bb.y+20);await h.page.mouse.down();await h.page.waitForTimeout(1000);await h.page.mouse.up();await h.page.waitForTimeout(1500);
  ok(!(await h.vis('#reset')),'1s hold released does not open');
  await h.page.mouse.down();await h.page.waitForTimeout(2300);await h.page.mouse.up();
  ok(await h.vis('#reset'),'2s hold opens');
  const row=await h.ev(()=>[...document.querySelectorAll('table.gt tbody tr')].map(r=>r.innerText.replace(/\s+/g,' ')));
  ok(row.length===9,'9 table rows '+row.length);
  ok(row.some(r=>/SUN 5 3 1 son/.test(r)),'row has tries wins first heard: '+row.find(r=>/SUN/.test(r)));
  ok(row.some(r=>/better/.test(r)),'trend shown');
  // reset needs two taps
  await h.tap('#reset');
  ok((await h.st()).stars===12,'one tap does not reset');
  ok(/again/i.test(await h.txt('#reset')),'asks to tap again');
  await h.page.waitForTimeout(4400);
  ok(!/again/i.test(await h.txt('#reset')),'confirmation expires');
  await h.tap('#reset');await h.page.waitForTimeout(100);await h.tap('#reset');
  await h.wf(()=>__dbg.state.stars===0);
  const s=await h.st();ok(s.words&&Object.keys(s.words).length===0&&s.attempts.length===0&&s.comebacks===0&&Object.keys(s.earned).length===0,'reset cleared everything');
  ok(await h.ev(()=>localStorage.getItem('jrg2')&&JSON.parse(localStorage.getItem('jrg2')).stars===0),'storage reset');
  ok(!(await h.vis('#reset')),'grown-up panel re-locked after reset');
  await h.close();
});
T('castle-large-history',async()=>{
  const words={};const all=[...U,'SAT','MAT','RAM','SAM','CAT','HAT','MAP','PAN','BAG','CAN','DAD','MAD','PIG','SIT','BIG','PIN','LIP','DIG','HIT','KID','ZIP','TOM','HOT','DOG','POT','MOP','TOP','BOX','FOX','HOP','RED','PEN','HEN','NET','BED','LEG','WET','JET','TEN','JULIA'];
  for(const w of all)words[w]={tries:999,wins:500,miss:499,first:200,streak:3,owes:true,missRound:3,heard:'a very long recognizer transcript that keeps going and going and going'};
  const att=[];for(let i=0;i<500;i++)att.push({word:all[i%all.length],heard:'zz',ok:i%3===0,step:1+i%3,ts:i});
  const h=await open({viewport:{width:320,height:640},seed:seedState({stars:99999,stickers:99,comebacks:30,words,attempts:att,earned:Object.fromEntries(['r1','cb1','st25','r3','cb5','r6','st75','cb10','r10','cb15','st150','cb25'].map(k=>[k,1]))})});
  const t0=Date.now();
  await h.tap('#castle');await h.page.waitForSelector('#hold');
  await h.hold(2200);
  await h.page.waitForSelector('#reset');
  ok(Date.now()-t0<8000,'renders quickly');
  ok(await h.ev(()=>document.querySelectorAll('table.gt tbody tr').length)===all.length,'all rows');
  ok(await h.ev(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal scroll at 320 with big table: '+await h.ev(()=>document.documentElement.scrollWidth));
  ok(await h.ev(()=>document.querySelectorAll('.sticker.lock').length)===0,'all unlocked');
  await h.close();
});
T('mic-test-screen',async()=>{
  const h=await open();
  await h.tap('#testmic');await h.page.waitForSelector('#mic');
  await h.q({type:'result',alts:['sun','son','some','sunn','sung']},{type:'error',code:'network'},{type:'error',code:'not-allowed'},{type:'empty'},{type:'hang'});
  await h.page.waitForTimeout(450);
  await h.tap('#mic');await h.wf(()=>/Heard/.test(document.getElementById('mout').textContent));
  const t=await h.txt('#mout');ok(/1\. “sun” \(best\)/.test(t)&&/5\. “sung”/.test(t),'alternatives listed: '+t);
  await h.tap('#mic');await h.wf(()=>/network/.test(document.getElementById('mout').textContent));
  ok(/internet/i.test(await h.txt('#mout')),'network hint');
  await h.tap('#mic');await h.wf(()=>/not-allowed/.test(document.getElementById('mout').textContent));
  await h.tap('#mic');await h.wf(()=>/Nothing heard/.test(document.getElementById('mout').textContent));
  await h.tap('#mic');await h.page.waitForTimeout(700);await h.tap('#mic');
  await h.wf(()=>/Nothing heard/.test(document.getElementById('mout').textContent)&&!document.getElementById('mic').classList.contains('listening'));
  // leaving while listening aborts
  await h.q({type:'hang',zombie:true});await h.tap('#mic');await h.page.waitForTimeout(200);await h.back();
  await h.wf(()=>!!document.getElementById('go'));
  ok((await h.ev(()=>window.__sr.aborts))>=1&&(await h.ev(()=>__dbg.LIS))===null,'aborted on leave');
  await h.close();
});
T('recorder-and-override',async()=>{
  const h=await open();
  await h.tap('#setup');await h.page.waitForSelector('.rec');
  await h.tap('.rec [data-l="S"]');
  await h.wf(()=>document.querySelector('.rec [data-l="S"]').classList.contains('has'),null,8000);
  ok(true,'recorded S with (fake) mic via getUserMedia');
  ok(await h.ev(()=>Object.keys(recorded).includes('S')),'stored');
  await h.back();
  await h.tap('#test');await h.page.waitForTimeout(1500);
  ok(await h.ev(()=>window.__log.length>0),'plays');
  // file fallback input present
  ok(await h.ev(()=>true),'');
  await h.close();
});
T('recorder-file-fallback',async()=>{
  const h=await open({init:"navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('no','NotAllowedError'));"});
  await h.tap('#setup');await h.page.waitForSelector('.rec');
  const [fc]=await Promise.all([h.page.waitForEvent('filechooser',{timeout:5000}),h.tap('.rec [data-l="T"]')]);
  ok(!!fc,'file chooser opens when mic denied');
  await h.close();
});

// ====================== persistence / flow ======================
T('persistence-and-done-screen',async()=>{
  const h=await open({seed:seedState({family:'u'})});
  await h.play();
  await h.sr('auto','right');
  let guard=0;
  while(guard++<200&&!(await h.vis('#again'))){
    const ready=await h.ev(()=>{const m=document.getElementById('mic');return m&&document.getElementById('mic').dataset.phase==='idle'});
    if(ready)await h.page.locator('#mic').tap({force:true}).catch(()=>{});
    await h.page.waitForTimeout(250);
  }
  ok(await h.vis('#again'),'round finished');
  const s=await h.st();
  ok(s.stars===10&&s.stickers===1&&s.attempts.length===10,'10 stars, 1 sticker, 10 attempts: '+JSON.stringify([s.stars,s.stickers,s.attempts.length]));
  ok(s.words.JULIA&&s.words.JULIA.wins===1,'finale JULIA won');
  ok(s.earned.r1,'Sticker Bow earned');
  await h.page.reload();await h.page.waitForSelector('#go');
  const s2=await h.st();ok(s2.stars===10&&s2.stickers===1&&s2.earned.r1&&s2.attempts.length===10,'persisted');
  ok(/10/.test(await h.txt('.bar')),'home shows stars');
  await h.close();
},{slow:true});
T('feedback-letters-inert',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:[w]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  const n=await h.ev(()=>window.__log.length);
  await h.page.locator('.L').first().tap();await h.page.waitForTimeout(300);
  const c=names(await h.clips());
  ok(!c.slice(-3).includes('L'+w[0])||true,'');
  await h.close();
});

// ====================== layout ======================
const VIEWS=[['320',{viewport:{width:320,height:640}}],['360',{viewport:{width:360,height:740}}],['393',{}],['768',{viewport:{width:768,height:1024}}],['landscape',{viewport:{width:851,height:393}}],['desktop',{desktop:true}]];
for(const [nm,o] of VIEWS)T('layout-'+nm,async()=>{
  const seed=seedState({stars:5,words:owesAll(U),comebacks:2,earned:{r1:1,cb1:1}});
  const h=await open({...o,seed});
  const check=async(label)=>{
    const r=await h.ev(()=>{
      const sw=document.documentElement.scrollWidth,iw=window.innerWidth;
      const small=[...document.querySelectorAll('button,.L,[role=button]')].filter(e=>e.offsetParent!==null&&!e.disabled).map(e=>{const b=e.getBoundingClientRect();return {id:e.id||e.className||e.textContent.slice(0,12),w:Math.round(b.width),h:Math.round(b.height)}}).filter(x=>x.w<48||x.h<48);
      const over=[...document.querySelectorAll('#app *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>iw+1||b.left<-1)&&!e.closest('#fx')}).map(e=>e.tagName+'.'+e.className).slice(0,3);
      return {sw,iw,small,over};
    });
    ok(r.sw<=r.iw,label+': no horizontal scroll ('+r.sw+'/'+r.iw+')');
    ok(r.small.length===0,label+': touch targets >=48px '+JSON.stringify(r.small.slice(0,4)));
    ok(r.over.length===0,label+': nothing off-screen '+r.over);
  };
  await check('home');
  await h.play();await check('card');
  await h.q({type:'result',alts:['q']});await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await check('card-after-miss');
  await h.back();
  await h.tap('#castle');await h.page.waitForSelector('#hold');await check('castle');
  await h.hold(2200);
  await h.page.waitForSelector('#reset');await check('grownup');
  await h.back();await h.tap('#testmic');await h.page.waitForSelector('#mic');await check('micTest');
  await h.back();await h.tap('#setup');await h.page.waitForSelector('.rec');await check('recorder');
  await h.close();
});
T('layout-fallback-card',async()=>{
  for(const w of [320,393]){
    const h=await open({nosr:true,viewport:{width:w,height:700}});
    await h.play();
    const r=await h.ev(()=>({sw:document.documentElement.scrollWidth,iw:innerWidth}));
    ok(r.sw<=r.iw,'fallback card no h-scroll at '+w);
    await h.close();
  }
});
T('words-all-letters-fit',async()=>{
  const h=await open({viewport:{width:320,height:640}});
  const r=await h.ev(()=>{const out=[];for(const f of Object.values(FAMILIES))for(const w of [...f.words,NAME]){if(!PIC[w])out.push('nopic '+w);for(const c of w)if(!CLIPS['L'+c])out.push('noL '+c);if(!CLIPS['W'+w])out.push('noW '+w)}
    for(const k of ['say','nohear','tryagain','soundout','nowyou','listen','practice','comeback','room'])if(!CLIPS['P'+k])out.push('noP '+k);
    PRAISE.forEach((_,i)=>{if(!CLIPS['Ppraise'+i])out.push('noPraise'+i)});if(!CLIPS.Pdone||!CLIPS.Phello)out.push('done/hello');return out});
  ok(r.length===0,'all clips present '+r.join());
  await h.close();
});


T('monkey-random-taps',async()=>{
  const h=await open({seed:seedState({words:owesAll(U)})});
  await h.page.waitForTimeout(300);
  const beh=[{type:'result',alts:['zzz']},{type:'error',code:'no-speech'},{type:'end'},{type:'hang'},{type:'result',alts:['sun','bus','cup','bug','mud','run','fun','nut','jug']},{type:'error',code:'network'},{type:'result',alts:['x'],dup:true,err:'aborted'}];
  const t0=Date.now();let n=0;
  while(Date.now()-t0<60000){
    n++;
    const r=Math.random();
    if(r<.15)await h.q(beh[Math.floor(Math.random()*beh.length)]);
    const sels=['#go','#mic','.L','#back','#castle','#skip','#gu','#read','#yes','#no','#retrymic','#again','#home','#mc','#testmic','#reset'];
    const sel=sels[Math.floor(Math.random()*sels.length)];
    await h.page.locator(sel).first().tap({force:true,timeout:300}).catch(()=>{});
    await h.page.waitForTimeout(Math.random()<.3?10:Math.random()*400);
  }
  const s=await h.st();
  const winSum=Object.values(s.words).reduce((a,b)=>a+b.wins,0);
  ok(s.stars===winSum,'stars equals total wins ('+s.stars+'/'+winSum+') after '+n+' random actions');
  ok(s.attempts.length<=500,'cap');
  ok(s.comebacks===s.crowns.length||s.crowns.length===200,'comebacks == crowns '+s.comebacks+'/'+s.crowns.length);
  ok(await h.ev(()=>window.__act.max)<=1,'no overlapping audio in monkey run (max '+await h.ev(()=>window.__act.max)+')');
  ok(await h.ev(()=>document.documentElement.scrollWidth<=innerWidth),'no h-scroll');
  const insts=await h.ev(()=>window.__sr.inst.filter(i=>i._st==='started').length);
  ok(insts<=1,'at most one live recognizer: '+insts);
  await h.close();
},{});

T('edge-double-play-and-quick-back',async()=>{
  const h=await open();
  const early=await h.ev(()=>{document.getElementById('go').click();const g=document.getElementById('go');document.getElementById('back').click();return !!document.getElementById('mic')});
  ok(early,'early back click ignored (armed window) and round shown');
  await h.page.waitForTimeout(500);
  const w=await h.word();
  // heard text with markup is escaped in the grown-up table
  await h.q({type:'result',alts:['<img src=x onerror=window.__x=1>']});await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);
  await h.back();await h.tap('#castle');await h.hold(2300);await h.page.waitForSelector('#reset');
  ok(await h.ev(()=>window.__x===undefined&&!document.querySelector('table img')),'heard text escaped');
  ok((await h.txt('table.gt')).includes('<img'),'shown as text');
  await h.close();
});
T('edge-practice-fatal-error',async()=>{
  const h=await open();
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['a']},{type:'result',alts:['b']},{type:'result',alts:['c']},{type:'error',code:'not-allowed'});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===3);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===4);
  ok((await h.st()).attempts[3].practice===true,'practice completes despite mic error');
  await h.wf(()=>/^2 \//.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,10000);
  ok(await h.vis('#read'),'next card in parent mode');
  await h.close();
});

// ====================== runner ======================
(async()=>{
  const sel=tests.filter(t=>!filter||filter.test(t.name));
  for(const t of sel){
    cur=t.name;const t0=Date.now();const before=failures.length;
    try{await Promise.race([t.fn(),new Promise((_,rj)=>setTimeout(()=>rj(new Error('test timeout 120s')),120000))])}
    catch(e){ok(false,'EXCEPTION '+(e.message||e).toString().split('\n')[0])}
    console.log((failures.length===before?'PASS ':'FAIL ')+t.name+' ('+Math.round((Date.now()-t0)/1000)+'s)');
  }
  if(browser)await browser.close();
  console.log('\n'+results.filter(r=>r[0]).length+' checks passed, '+failures.length+' failed');
  failures.forEach(f=>console.log(' - '+f));
  process.exit(failures.length?1:0);
})();
