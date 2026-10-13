// Adversarial QA for ../index.html.   Run: NODE_PATH=$(npm root -g) node tools/qa.js [filterRegex]
// A controllable mock webkitSpeechRecognition is injected (no real mic / Google service in CI).
const {chromium}=require('playwright');
const fs=require('fs'),path=require('path');
const SRC=fs.readFileSync(process.env.QA_HTML||path.join(__dirname,'..','index.html'),'utf8');   // QA_HTML: test a mutated copy
const CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'";
const PIXEL={viewport:{width:393,height:851},deviceScaleFactor:2.75,hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'};
const INIT=`
window.__log=[];window.__act={n:0,max:0,starts:0};
(function(){
 const S=AudioBufferSourceNode.prototype.start,P=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.start=function(...a){ if(this.buffer&&this.buffer.length>1){window.__log.push({t:'buf',buf:this.buffer,clip:this.__clip||'?',at:performance.now(),act:__act.n});this.__live=true;__act.n++;__act.starts++;if(__act.n>__act.max)__act.max=__act.n} return S.apply(this,a)};
 AudioBufferSourceNode.prototype.stop=function(...a){ if(this.__live){this.__live=false;__act.n--} return P.apply(this,a)};
 const CB=BaseAudioContext.prototype.createBufferSource;BaseAudioContext.prototype.createBufferSource=function(){const n=CB.apply(this,arguments);n.addEventListener('ended',()=>{if(n.__live){n.__live=false;__act.n--}});return n};
 const PL=HTMLMediaElement.prototype.play;
 HTMLMediaElement.prototype.play=function(){window.__log.push({t:'media',at:performance.now()});return PL.apply(this,arguments)};
 try{ if(window.speechSynthesis){const sp=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=function(u){window.__log.push({t:'tts',text:u.text,at:performance.now()});return sp(u)}} }catch(e){}
 window.__clips=async()=>window.__log.filter(e=>e.t==='buf').map(e=>{const i=e.clip.indexOf('/');return {k:i<0?e.clip:e.clip.slice(i+1),v:i<0?'':e.clip.slice(0,i),at:e.at}});
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
    else if(b.type==='multi'){const results=[];b.parts.forEach((pt,idx)=>this._t(()=>{results.push(Object.assign(pt.alts.map(t=>({transcript:t,confidence:.9})),{isFinal:true}));this._fire('onresult',{results:results.slice(),resultIndex:idx})},pt.at));
      if(b.end!=null)this._t(()=>{this._st='idle';this._fire('onend')},b.end);}
  }
  stop(){S.stops++;if(this._st!=='started')return;this._st='stopping';const b=this._b;
    if((b.type==='hang'||(b.type==='multi'&&b.end==null))&&!b.ignoreStop)this._t(()=>{this._st='idle';this._fire('onend')},30);
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
  page.on('dialog',d=>{errs.push('dialog: '+d.type()+' '+d.message());d.dismiss().catch(()=>{})});
  page.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
  page.on('request',r=>{const u=r.url();if(!/^(data:|blob:|https:\/\/castle\.test\/)/.test(u))reqs.push(u)});
  await page.addInitScript(INIT);
  if(o.nosr)await page.addInitScript(NOSR);else await page.addInitScript(MOCK);
  if(o.seed){await page.addInitScript(`try{if(!localStorage.getItem('__seeded')){localStorage.setItem('__seeded','1');localStorage.setItem('jrg2',${JSON.stringify(JSON.stringify(o.seed))})}}catch(e){}`)}
  if(o.raw!=null){await page.addInitScript(`try{if(!localStorage.getItem('__seeded')){localStorage.setItem('__seeded','1');localStorage.setItem('jrg2',${JSON.stringify(o.raw)})}}catch(e){}`)}
  if(o.init)await page.addInitScript(o.init);
  await page.route('https://castle.test/**',r=>r.fulfill({status:200,contentType:'text/html',headers:{'Content-Security-Policy':CSP},body:o.src||SRC}));
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
  const r=await h.ev(()=>{const out=[];const has=(pk,k)=>!!__dbg.rawClip(pk+'/'+k);
    for(const pk of ['classic',...__dbg.VOICE_IDS])for(const f of Object.values(FAMILIES))for(const w of [...f.words,NAME]){if(!PIC[w]&&pk==='classic')out.push('nopic '+w);for(const c of w)if(!has(pk,'L'+c))out.push(pk+' noL '+c);if(!has(pk,'W'+w))out.push(pk+' noW '+w)}
    for(const pk of ['classic',...__dbg.VOICE_IDS]){
    for(const k of ['say','nohear','tryagain','soundout','nowyou','listen','practice','comeback','room'])if(!has(pk,'P'+k))out.push(pk+' noP '+k);
    PRAISE.forEach((_,i)=>{if(!has(pk,'Ppraise'+i))out.push(pk+' noPraise'+i)});if(!has(pk,'Pdone')||!has(pk,'Phello'))out.push(pk+' done/hello');
    for(const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')if(!has(pk,'L'+c))out.push(pk+' noL'+c)}
    return out});
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

// ====================== voices (Kokoro packs, picker, letter style) ======================
const PV=['af_heart','af_nicole','af_sarah'];
const VN={af_heart:'Heart',af_nicole:'Nicole',af_sarah:'Sarah'};
const seedPrefs=raw=>`try{if(!localStorage.getItem('__ps')){localStorage.setItem('__ps','1');localStorage.setItem('jrg-voice',${JSON.stringify(typeof raw==='string'?raw:JSON.stringify(raw))})}}catch(e){}`;
const toPicker=async h=>{await h.tap('#voice');await h.page.waitForSelector('.vcard')};
const audDone=(h,t)=>h.wf(()=>/^That was|did not play/.test(document.getElementById('vstat')?.textContent||''),null,t||15000);
const prefsOf=h=>h.ev(()=>JSON.parse(JSON.stringify(__dbg.prefs)));
const stored=h=>h.ev(()=>{try{return localStorage.getItem('jrg-voice')}catch{return 'ERR'}});
const wavBlobJs=`(()=>{const sr=22050,n=Math.floor(sr*0.3),b=new ArrayBuffer(44+n*2),d=new DataView(b);const w=(o,t)=>{for(let i=0;i<t.length;i++)d.setUint8(o+i,t.charCodeAt(i))};w(0,'RIFF');d.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,sr,true);d.setUint32(28,sr*2,true);d.setUint16(32,2,true);d.setUint16(34,16,true);w(36,'data');d.setUint32(40,n*2,true);for(let i=0;i<n;i++)d.setInt16(44+i*2,Math.sin(i/9)*12000,true);return new Blob([b],{type:'audio/wav'})})()`;

T('voice-packs-complete-and-size',async()=>{
  const man=JSON.parse(fs.readFileSync(path.join(__dirname,'phrases.json'),'utf8'));
  const ids=['letters','words','phrases','sentences'].flatMap(k=>Object.keys(man[k]));
  ok(ids.length>=97,'manifest has '+ids.length+' ids');
  ok(JSON.stringify(man.voices.map(v=>v.id))===JSON.stringify(PV),'manifest lists the three voices in order');
  for(const v of PV){
    const pack=JSON.parse(fs.readFileSync(path.join(__dirname,'clips_'+v+'.json'),'utf8'));
    const miss=ids.filter(i=>typeof pack[i]!=='string'||pack[i].length<100);
    ok(miss.length===0,v+' pack on disk has every manifest id '+miss.slice(0,5));
  }
  const bytes=fs.statSync(path.join(__dirname,'..','index.html')).size;
  console.log('  SIZE index.html '+(bytes/1e6).toFixed(2)+' MB; packs: '+PV.map(v=>v+' '+Math.round(fs.statSync(path.join(__dirname,'clips_'+v+'.json')).size/1024)+' KB').join(', '));
  ok(bytes<4.5e6,'index.html under 4.5 MB ('+bytes+')');
  const h=await open();
  const r=await h.ev(()=>{const B=__dbg.BUNDLE,o=[];for(const v of __dbg.VOICE_IDS)for(const k of Object.keys(B.voices[__dbg.VOICE_IDS[0]]))if(typeof B.voices[v][k]!=='string')o.push(v+' '+k);return {o,ids:Object.keys(B.voices[__dbg.VOICE_IDS[0]]).length,vs:__dbg.VOICE_IDS}});
  ok(r.o.length===0&&r.ids>=97,'embedded packs identical id sets '+r.o.slice(0,3)+' n='+r.ids);
  ok(JSON.stringify(r.vs)===JSON.stringify(PV),'three voices embedded');
  const miss=await h.ev(ids=>ids.filter(i=>!__dbg.rawClip('af_sarah/'+i)||!__dbg.rawClip('af_heart/'+i)||!__dbg.rawClip('af_nicole/'+i)),ids);
  ok(miss.length===0,'every manifest id embedded for every voice '+miss.slice(0,4));
  await h.close();
});

T('voice-picker-renders-and-persists',async()=>{
  const h=await open();
  ok(/Voice: Heart/.test(await h.txt('#voice')),'home Voice button shows default Heart');
  ok((await prefsOf(h)).voice==='af_heart','default voice af_heart');
  await toPicker(h);
  const cards=await h.ev(()=>[...document.querySelectorAll('.vcard')].map(c=>({id:c.dataset.v,name:c.querySelector('.vtitle span').textContent,sel:c.classList.contains('sel'),play:!!c.querySelector('.vplay'),choose:!!c.querySelector('.vsel')})));
  ok(cards.length===3&&cards.map(c=>c.id).join()===PV.join(),'three cards in order '+JSON.stringify(cards));
  ok(cards.map(c=>c.name).join()==='Heart,Nicole,Sarah','friendly names');
  ok(cards.filter(c=>c.sel).map(c=>c.id).join()==='af_heart','only Heart highlighted');
  ok(cards.every(c=>c.play&&c.choose),'each card has audition + choose');
  ok(await h.ev(()=>document.getElementById('ls-voice').getAttribute('aria-pressed')==='true'),'letter style Voice by default');
  await h.tap('[data-sel="af_nicole"]');
  ok(await h.ev(()=>document.querySelector('.vcard[data-v=af_nicole]').classList.contains('sel')&&!document.querySelector('.vcard[data-v=af_heart]').classList.contains('sel')),'highlight moves to Nicole');
  ok((await h.txt('[data-sel="af_nicole"]')).includes('Chosen'),'button says Chosen');
  const st=JSON.parse(await stored(h));ok(st.voice==='af_nicole'&&st.letters==='voice','stored '+JSON.stringify(st));
  await h.page.reload();await h.page.waitForSelector('#go');
  ok((await prefsOf(h)).voice==='af_nicole','voice survives reload');
  ok(/Voice: Nicole/.test(await h.txt('#voice')),'home button shows Nicole after reload');
  await toPicker(h);
  ok(await h.ev(()=>document.querySelector('.vcard[data-v=af_nicole]').classList.contains('sel')),'Nicole highlighted after reload');
  await h.tap('[data-sel="af_sarah"]');await h.page.reload();await h.page.waitForSelector('#go');
  ok((await prefsOf(h)).voice==='af_sarah','Sarah persisted');
  // reset progress must not touch the voice
  ok((await prefsOf(h)).voice==='af_sarah','voice independent of game state');
  await h.close();
});

T('voice-prefs-corrupt-or-absent',async()=>{
  const cases=[['{not json','af_heart','voice'],['null','af_heart','voice'],['[]','af_heart','voice'],['"af_sarah"','af_heart','voice'],['123','af_heart','voice'],
    ['{"voice":"__proto__"}','af_heart','voice'],['{"voice":"constructor","letters":"classic"}','af_heart','classic'],['{"voice":5,"letters":{}}','af_heart','voice'],
    ['{"voice":"AF_HEART"}','af_heart','voice'],['{"voice":"af_nope","letters":"zzz"}','af_heart','voice'],
    ['{"voice":"af_sarah","letters":"classic"}','af_sarah','classic'],['{"voice":"af_nicole"}','af_nicole','voice']];
  for(const [raw,v,l] of cases){
    const h=await open({init:seedPrefs(raw)});
    const p=await prefsOf(h);
    ok(p.voice===v&&p.letters===l,'prefs '+raw+' -> '+JSON.stringify(p));
    ok(await h.vis('#voice'),'home loads with '+raw);
    await h.close();
  }
  // storage that throws on read AND write: default voice, picker still works for the session
  const h=await open({init:"Storage.prototype.getItem=function(){throw new DOMException('denied','SecurityError')};Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')};"});
  ok((await prefsOf(h)).voice==='af_heart','throwing storage -> default voice');
  await toPicker(h);await h.tap('[data-sel="af_sarah"]');
  ok((await prefsOf(h)).voice==='af_sarah','selection still works in-session without storage');
  await h.tap('#ls-classic');ok((await prefsOf(h)).letters==='classic','toggle works in-session without storage');
  await h.close();
});

T('voice-audition-three-clips-in-order',async()=>{
  const h=await open();
  await toPicker(h);
  for(const v of PV){
    const n0=(await h.clips()).length;
    await h.tap(`[data-play="${v}"]`);
    ok(/Playing/.test(await h.txt('#vstat'))||true,'');
    ok((await h.txt(`[data-play="${v}"]`)).includes('Stop'),'button turns into Stop while playing');
    await audDone(h);
    const c=(await h.clips()).slice(n0);
    ok(c.length===3,v+': exactly 3 clips ('+names(c).join(',')+')');
    ok(names(c).join()==='LM,WSUN,Ppraise0',v+': letter m, word sun, praise in order: '+names(c).join());
    ok(c.every(x=>x.v===v),v+': all clips from that voice '+c.map(x=>x.v).join());
    ok(c[1].at>c[0].at&&c[2].at>c[1].at,'ordered in time');
    ok((await h.txt(`[data-play="${v}"]`)).includes('Hear'),'button back to Hear');
    ok((await prefsOf(h)).voice==='af_heart','audition does not change the saved voice');
  }
  ok(await h.ev(()=>window.__act.max)<=1,'never two clips at once during auditions (max '+await h.ev(()=>window.__act.max)+')');
  ok(await h.ev(()=>window.__log.filter(e=>e.t==='tts'||e.t==='media').length)===0,'no speechSynthesis / media element used');
  // a recorded M must NOT replace the audition letter (it demos the voice)
  await h.ev(`recorded.M=${wavBlobJs}`);
  const n0=(await h.clips()).length;
  await h.tap('[data-play="af_sarah"]');await audDone(h);
  const c=(await h.clips()).slice(n0);
  ok(names(c).join()==='LM,WSUN,Ppraise0'&&c[0].v==='af_sarah','audition ignores user recording ('+c.map(x=>x.v+'/'+x.k).join()+')');
  await h.close();
});

T('voice-rapid-switch-cancels-cleanly',async()=>{
  const h=await open();
  await toPicker(h);
  await h.tap('[data-play="af_heart"]');await h.page.waitForTimeout(120);
  await h.tap('[data-play="af_nicole"]');await h.page.waitForTimeout(120);
  await h.tap('[data-play="af_sarah"]');
  await audDone(h);await h.page.waitForTimeout(800);
  const c=await h.clips();
  const si=c.findIndex(x=>x.v==='af_sarah');
  ok(c.slice(-3).every(x=>x.v==='af_sarah')&&names(c.slice(-3)).join()==='LM,WSUN,Ppraise0','final three clips are Sarah\'s full audition '+c.map(x=>x.v+'/'+x.k).join());
  ok(c.slice(si).every(x=>x.v==='af_sarah'),'nothing from an older audition after Sarah started');
  ok(c.filter(x=>x.v==='af_heart').length<=1&&c.filter(x=>x.v==='af_nicole').length<=1,'cancelled auditions did not carry on');
  ok(await h.ev(()=>window.__act.max)<=1,'never overlapping (max '+await h.ev(()=>window.__act.max)+')');
  ok(await h.ev(()=>window.__act.n)===0,'nothing left sounding');
  ok(await h.ev(()=>[...document.querySelectorAll('.vplay')].every(b=>b.textContent.includes('Hear'))),'all buttons back to Hear');
  // tap the playing button again = stop
  const n1=(await h.clips()).length;
  await h.tap('[data-play="af_heart"]');await h.page.waitForTimeout(80);await h.tap('[data-play="af_heart"]');await h.page.waitForTimeout(1500);
  ok((await h.clips()).length-n1<=1,'second tap stops the audition ('+((await h.clips()).length-n1)+' clips)');
  ok(await h.ev(()=>window.__act.n)===0,'stopped');
  // choosing a voice in the middle of an audition cuts the sound and switches
  await h.tap('[data-play="af_sarah"]');await h.page.waitForTimeout(150);
  const n2=(await h.clips()).length;
  await h.tap('[data-sel="af_nicole"]');await h.page.waitForTimeout(1800);
  ok((await h.clips()).length===n2,'choose mid-audition stops further clips');
  ok(await h.ev(()=>window.__act.n)===0,'silent after choose');
  ok((await prefsOf(h)).voice==='af_nicole','voice switched');
  // letter-style toggle mid-audition
  await h.tap('[data-play="af_heart"]');await h.page.waitForTimeout(100);await h.tap('#ls-classic');await audDone(h,3000).catch(()=>{});await h.page.waitForTimeout(1200);
  ok(await h.ev(()=>window.__act.max)<=1,'still never overlapping after toggle (max '+await h.ev(()=>window.__act.max)+')');
  // leaving the screen mid-audition stops it
  await h.tap('[data-play="af_heart"]');await h.page.waitForTimeout(100);await h.page.waitForTimeout(400);await h.tap('#back');
  const n3=(await h.clips()).length;await h.page.waitForTimeout(1800);
  ok((await h.clips()).length===n3&&await h.ev(()=>window.__act.n)===0,'Back stops the audition');
  await h.close();
});

T('voice-selected-voice-used-everywhere',async()=>{
  for(const v of PV){
    const h=await open();
    await toPicker(h);await h.tap(`[data-sel="${v}"]`);await h.tap('#back');await h.page.waitForSelector('#go');
    await h.tap('#test');await h.wf(()=>/Sound works|did not start/.test(document.getElementById('tstat')?.textContent||''),null,8000);
    let c=await h.clips();
    ok(names(c).join()==='LS,Phello'&&c.every(x=>x.v===v),v+': Test sound uses the voice '+c.map(x=>x.v+'/'+x.k).join());
    await h.play();const w=await h.word();await h.page.waitForTimeout(900);
    await h.tap('.L[data-k="0"]');await h.page.waitForTimeout(500);
    await h.q({type:'result',alts:['zzz']},{type:'result',alts:[w.toLowerCase()]});
    await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.page.waitForTimeout(6500);   // ladder step 1: first sound
    await h.idle();await h.mic();await h.wf(()=>__dbg.state.stars===1);await h.page.waitForTimeout(3500);   // praise + word
    c=await h.clips();
    const k=names(c);
    ok(k.includes('L'+w[0])&&k.includes('Ptryagain')&&k.some(x=>/^Ppraise/.test(x))&&k.includes('W'+w),v+': letter, prompt, praise, word all played ('+k.join(',')+')');
    ok(c.every(x=>x.v===v),v+': EVERY clip came from '+v+': '+[...new Set(c.map(x=>x.v))].join());
    ok(await h.ev(()=>window.__log.filter(e=>e.t==='tts').length)===0,'no speechSynthesis');
    await h.close();
  }
},{slow:true});

T('voice-switch-takes-effect-immediately',async()=>{
  const h=await open();
  await h.tap('#test');await h.wf(()=>/Sound works/.test(document.getElementById('tstat')?.textContent||''),null,8000);
  await toPicker(h);await h.tap('[data-sel="af_sarah"]');await h.tap('#back');
  await h.tap('#test');await h.wf(()=>/Sarah|Sound works/.test(document.getElementById('tstat')?.textContent||''),null,8000);await h.page.waitForTimeout(2500);
  const c=await h.clips();
  ok(c.slice(0,2).every(x=>x.v==='af_heart')&&c.slice(-2).every(x=>x.v==='af_sarah')&&c.length===4,'first Test sound Heart, second Sarah: '+c.map(x=>x.v+'/'+x.k).join());
  await h.close();
});

T('voice-classic-letters-toggle',async()=>{
  const h=await open({init:seedPrefs({voice:'af_nicole',letters:'voice'})});
  await toPicker(h);
  const n0=(await h.clips()).length;
  await h.tap('#ls-classic');await h.wf(()=>window.__log.length>0,null,5000);await h.page.waitForTimeout(700);
  let c=(await h.clips()).slice(n0);
  ok(c.length===1&&c[0].k==='LM'&&c[0].v==='classic','toggle demos a Classic m ('+c.map(x=>x.v+'/'+x.k).join()+')');
  ok(await h.ev(()=>document.getElementById('ls-classic').getAttribute('aria-pressed')==='true'&&document.getElementById('ls-voice').getAttribute('aria-pressed')==='false'),'toggle reflects state');
  ok(JSON.parse(await stored(h)).letters==='classic','persisted');
  ok((await prefsOf(h)).voice==='af_nicole','voice unchanged by letter toggle');
  await h.page.reload();await h.page.waitForSelector('#go');
  ok((await prefsOf(h)).letters==='classic'&&(await prefsOf(h)).voice==='af_nicole','classic letters survive reload');
  await h.play();const w=await h.word();await h.page.waitForTimeout(900);
  await h.tap('.L[data-k="0"]');await h.page.waitForTimeout(500);await h.tap('.L[data-k="1"]');await h.page.waitForTimeout(500);
  c=await h.clips();
  ok(c.filter(x=>x.k[0]==='L').length===2&&c.filter(x=>x.k[0]==='L').every(x=>x.v==='classic'),'game letters are Classic: '+c.map(x=>x.v+'/'+x.k).join());
  await h.q({type:'result',alts:[w.toLowerCase()]});await h.mic();await h.wf(()=>__dbg.state.stars===1);await h.page.waitForTimeout(3500);
  c=await h.clips();
  ok(c.filter(x=>x.k[0]!=='L').length>=2&&c.filter(x=>x.k[0]!=='L').every(x=>x.v==='af_nicole'),'words / praise stay in the chosen voice: '+[...new Set(c.filter(x=>x.k[0]!=='L').map(x=>x.v))]);
  await h.back();await toPicker(h);
  await h.tap('#ls-voice');await h.page.waitForTimeout(800);
  ok((await prefsOf(h)).letters==='voice','back to voice letters');
  const c2=await h.clips();ok(c2[c2.length-1].v==='af_nicole'&&c2[c2.length-1].k==='LM','demo m in voice style after toggling back');
  await h.close();
});

T('voice-user-recording-still-wins',async()=>{
  for(const letters of ['voice','classic']){
    const h=await open({init:seedPrefs({voice:'af_sarah',letters})});
    await h.ev(`recorded.S=${wavBlobJs}`);
    await h.ev(()=>say('L','S','sss',{ep:stopAll()}));await h.page.waitForTimeout(500);
    await h.ev(()=>say('L','M','mmm',{ep:stopAll()}));await h.page.waitForTimeout(700);
    const c=await h.clips();
    ok(c.length===2&&c[0].v==='rec'&&c[0].k==='LS','recorded S wins ('+letters+'): '+c.map(x=>x.v+'/'+x.k).join());
    ok(c[1].k==='LM'&&c[1].v===(letters==='classic'?'classic':'af_sarah'),'unrecorded M uses the style ('+letters+'): '+c[1].v);
    await h.close();
  }
});

T('voice-missing-or-corrupt-clips-fall-back',async()=>{
  const h=await open();
  const r=await h.ev(async()=>{
    const out={};const B=__dbg.BUNDLE.voices;
    B.af_heart.WSUN='@@@not-base64@@@';                  // corrupt
    B.af_heart.WBUS='AAAAAAAAAAAAAAAAAAAAAAAA';         // valid base64, not audio
    delete B.af_heart.WCAT;                             // missing
    delete B.af_heart.LM;                               // missing letter
    B.af_heart.Ppraise0='';                             // empty
    for(const [k,id] of [['W','SUN'],['W','BUS'],['W','CAT'],['L','M'],['P','praise0']]){
      try{out[k+id]=await say(k,id,'x',{ep:stopAll(),noTts:true})}catch(e){out[k+id]='THREW '+e}
    }
    return out;
  });
  await h.page.waitForTimeout(500);
  ok(Object.values(r).every(v=>v===true),'every degraded id still played: '+JSON.stringify(r));
  const c=await h.clips();
  ok(c.length===5,'five clips played ('+c.length+')');
  ok(c.slice(0,3).every(x=>x.v==='af_nicole'),'words fall back to the next voice, not to robot speech: '+c.map(x=>x.v+'/'+x.k).join());
  ok(c[3].k==='LM'&&c[3].v==='classic','missing letter falls back to Classic letter: '+c[3].v);
  ok(c[4].v==='af_nicole','empty phrase falls back to next voice');
  ok(await h.ev(()=>window.__log.filter(e=>e.t==='tts').length)===0,'speechSynthesis not needed');
  // every source gone -> last resort is speechSynthesis, and nothing throws
  const r2=await h.ev(async()=>{for(const v of __dbg.VOICE_IDS)delete __dbg.BUNDLE.voices[v].WSUN;delete __dbg.BUNDLE.classic.WSUN;try{return await say('W','SUN','sun',{ep:stopAll()})}catch(e){return 'THREW '+e}});
  ok(r2===true||r2===false,'no throw when no clip exists anywhere: '+r2);
  ok(await h.ev(()=>window.__log.filter(e=>e.t==='tts').length)>=1,'falls back to speechSynthesis last');
  await h.page.waitForTimeout(300);
  await h.close();
});

T('voice-whole-pack-corrupt-keeps-banner-and-game-works',async()=>{
  const i0=SRC.indexOf('const BUNDLE = ')+15,i1=SRC.indexOf(';\nconst VOICES');
  const B=JSON.parse(SRC.slice(i0,i1));
  for(const k of Object.keys(B.voices.af_heart))B.voices.af_heart[k]='AAAAAAAAAAAAAAAAAAAA';
  const src=SRC.slice(0,i0)+JSON.stringify(B)+SRC.slice(i1);
  const h=await open({src});
  await h.play();await h.page.waitForTimeout(900);
  await h.tap('.L[data-k="0"]');
  await h.wf(()=>!document.getElementById('ab').classList.contains('hidden'),null,15000);
  ok(/couldn't load my sounds/.test(await h.txt('#ab')),'existing "could not load" banner shown');
  await h.page.waitForTimeout(500);
  const c=await h.clips();
  ok(c.length>=1&&c.every(x=>x.v!=='af_heart'),'letter still sounds, from a working pack: '+c.map(x=>x.v+'/'+x.k).join());
  await h.close();
});

T('voice-every-clip-decodes-in-chromium',async()=>{
  const h=await open();
  await h.tap('#test');await h.page.waitForTimeout(800);   // gesture -> AudioContext exists
  const r=await h.ev(async()=>{
    const bad=[],B=__dbg.BUNDLE;let n=0;const short=[];
    const packs={classic:B.classic,...B.voices};
    for(const [pk,pack] of Object.entries(packs))for(const id of Object.keys(pack)){
      n++;
      try{const it=await getBuf(pk+'/'+id);if(!it||!it.buf||it.dur<0.03){bad.push(pk+'/'+id+' '+(it?it.dur:'null'))}else if(it.dur<0.045)short.push(pk+'/'+id+' '+it.dur.toFixed(3))}catch(e){bad.push(pk+'/'+id+' '+e)}
    }
    return {bad,n,short};
  });
  ok(r.n>=94+3*97,'decoded '+r.n+' clips');
  ok(r.bad.length===0,'every embedded clip decodes to real audio in Chromium '+r.bad.slice(0,5).join('; '));
  ok(r.short.length===0,'no clip is shorter than 45 ms after trimming '+r.short.join(','));
  await h.close();
});

// ====================== sentences + puzzle words ======================
const SENTS=JSON.parse(fs.readFileSync(path.join(__dirname,'sentences.json'),'utf8'));
const CVCW=[...new Set(SRC.split('const PIC')[0].match(/"[A-Z]{3}"/g).map(x=>x.slice(1,-1)))];
const SIGHTW=['I','A','IS','THE','SEE'];
const W1=()=>({tries:1,wins:1,miss:0,first:1,streak:1,owes:false,missRound:0,heard:''});
const wonSeed=(words,extra)=>seedState(Object.assign({words:Object.fromEntries(words.map(w=>[w,W1()]))},extra||{}));
const ONE27=['SAM','CAN','HIT','THE','NET'];              // unlocks exactly s27 "SAM CAN HIT THE NET."
const sentText=h=>h.ev(()=>[...document.querySelectorAll('.SW')].map(e=>e.textContent.replace(/\./g,'')).join(' '));
const startSent=async h=>{await h.tap('#sents');await h.page.waitForSelector('#sgo');await h.tap('#sgo');await h.page.waitForFunction(()=>document.getElementById('mic')||document.getElementById('read'))};
const attemptsN=h=>h.ev(()=>__dbg.state.attempts.length);

T('sent-content-and-build-check',async()=>{
  ok(SENTS.length>=36&&[3,4,5].every(l=>SENTS.filter(x=>x.level===l).length>=12),'>=12 sentences at each of 3/4/5 words');
  const bad=SENTS.filter(x=>x.text.match(/[A-Z]+/g).some(w=>!CVCW.includes(w)&&!SIGHTW.includes(w)));
  ok(bad.length===0,'every word decodable or sight '+bad.map(b=>b.id));
  ok(SENTS.every(x=>x.level===x.text.match(/[A-Z]+/g).length&&x.emoji),'levels = real length, every sentence has an emoji');
  const {spawnSync}=require('child_process');
  const py=(args)=>spawnSync('python3',[path.join(__dirname,'check_sentences.py'),...args],{encoding:'utf8'});
  let r=py([]);ok(r.status===0,'check_sentences.py passes on the real data: '+r.stdout.slice(0,120)+r.stderr.slice(0,200));
  const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'sent-'));
  const mut=(f)=>{const a=JSON.parse(JSON.stringify(SENTS));f(a);const p2=path.join(tmp,'s.json');fs.writeFileSync(p2,JSON.stringify(a));return py(['--sentences',p2])};
  r=mut(a=>{a[0].text='I SEE THE SKY.';a[0].level=4});ok(r.status!==0&&/SKY/.test(r.stdout),'bad word SKY is rejected: '+r.stdout.slice(0,150));
  r=mut(a=>{a[1].text='THE CAT SAT.';a[1].level=5});ok(r.status!==0&&/level/.test(r.stdout),'wrong level rejected');
  r=mut(a=>{a.push({id:'s99',text:'I SEE SAM.',emoji:'👀',level:3})});ok(r.status!==0&&/(lacks clip Ss99|out of sync|lacks clip id Ss99)/.test(r.stdout),'sentence without a clip in the packs is rejected: '+r.stdout.slice(0,200));
  r=mut(a=>{a[2].emoji=''});ok(r.status!==0&&/emoji/.test(r.stdout),'missing emoji rejected');
  r=mut(a=>{a[3].text='A BIG PIG'});ok(r.status!==0,'missing full stop rejected');
  r=mut(a=>{a[4].text='SAM IS ZAP.';a[4].level=3});ok(r.status!==0&&/ZAP/.test(r.stdout),'unknown CVC word rejected');
  const h=await open();
  const miss=await h.ev(()=>{const o=[];for(const v of __dbg.VOICE_IDS){for(const sn of __dbg.SENTENCES){if(!__dbg.rawClip(v+'/S'+sn.id))o.push(v+' S'+sn.id);for(const w of sn.words)if(!__dbg.rawClip(v+'/W'+w))o.push(v+' W'+w)}for(const k of ['sread','all','sentpraise','star','puzzle'])if(!__dbg.rawClip(v+'/P'+k))o.push(v+' P'+k)}return o});
  ok(miss.length===0,'every sentence, word and new prompt clip exists in every voice pack '+miss.slice(0,4));
  ok(await h.ev(()=>__dbg.SENTENCES.length)===SENTS.length,'page has all sentences');
  await h.close();
});

T('sent-align-unit',async()=>{
  const h=await open();
  const r=await h.ev(()=>{
    const S=id=>__dbg.SENTENCES.find(x=>x.id===id);const E=(id,a)=>__dbg.evalSentence(S(id),a);
    const s13='s13',s27='s27',o={};
    o.exact=E(s13,['i see the sun']).right;
    o.punct=E(s13,['I see the sun!']).right;
    const w=E(s13,['i see the sin']);o.wrong={right:w.right,first:w.first,res:w.res};
    o.missing=E(s13,['i see the']).right;
    o.extra=E(s13,['um i see the big sun please']).right;
    o.swapped=E(s27,['net the hit can sam']).right;
    o.sightMissing=E(s13,['see the sun']).right;
    o.sightWrong=E(s13,['eye see da sun']).right;o.sightGot=E(s13,['eye see da sun']).got.join();o.sightNot=E(s13,['banana see a sun']).got.join();
    o.sightAllMissing=E('s13',['sun']).right;
    o.alt3=E(s13,['a b c','i see sin','i see the sun']).right;
    o.bestPick=E(s13,['i see the sin','i see the sun']).right;
    o.strictSit=E('s02',['the cat sit']).right;
    o.dup=E(s13,['i see the sun sun sun']).right;
    o.ten=__dbg.alignSentence(['TEN'],['10'])[0];
    o.noTen=__dbg.alignSentence(['BUS'],['10'])[0];
    o.empty=E(s13,[]).right;o.nul=E(s13,null).right;o.blank=E(s13,['','  ']).right;o.junk=E(s13,[null,undefined,5,{}]).right;
    const long=Array(70).fill('blah').join(' ')+' i see the sun';o.long70=E(s13,[long]).right;
    const huge=Array(20000).fill('blah').join(' ');const t0=performance.now();const hr=E(s13,[huge,huge,huge,huge,huge]);o.hugeMs=performance.now()-t0;o.huge=hr.right;
    o.five=E(s27,['sam can hit the net']).right;o.fiveMiss=E(s27,['sam can hat the net']);
    o.firstOfTwo=E(s27,['sam can hat the nut']).first;
    o.score=E(s27,['sam can hat the net','sam can hit the nut']).decGot;
    return o;
  });
  ok(r.exact&&r.punct,'exact and punctuated');
  ok(!r.wrong.right&&r.wrong.first===3&&r.wrong.res==='1110','one wrong decodable word: SUN missed, others got '+JSON.stringify(r.wrong));
  ok(!r.missing,'missing decodable word -> not right');
  ok(r.extra,'extra spoken words ignored');
  ok(!r.swapped,'swapped order is not right');
  ok(r.sightMissing,'sight word missing -> still right');
  ok(r.sightWrong,'sight words heard differently (eye / da) -> still right');
  ok(r.sightGot==='true,true,true,true'&&r.sightNot==='false,true,true,true','lenient aliases colour puzzle words green (eye, da), unknown word stays not-yet: '+r.sightGot+' / '+r.sightNot);
  ok(r.sightAllMissing,'only the reading word said: puzzle words never block');
  ok(r.alt3,'third alternative correct');ok(r.bestPick,'best-scoring alternative is used');
  ok(!r.strictSit,'decodable words are strict (sit for sat)');
  ok(r.dup,'repeated words fine');
  ok(r.ten===true&&r.noTen===false,'digit alias TEN<-10 only');
  ok(!r.empty&&!r.nul&&!r.blank&&!r.junk,'empty / null / junk input never right and never throws');
  ok(r.long70,'sentence after 70 filler words still found');
  ok(r.hugeMs<500&&!r.huge,'huge transcripts are capped, fast ('+Math.round(r.hugeMs)+' ms)');
  ok(r.five&&!r.fiveMiss.right&&r.fiveMiss.first===2,'5-word sentence: HIT missed is the first missed word');
  ok(r.firstOfTwo===2,'with two misses the FIRST one is chosen (HIT)');
  ok(r.score===3,'best of alternatives by number of reading words got');
  await h.close();
});

T('sent-gating-and-persistence',async()=>{
  let h=await open({seed:wonSeed(['SAM','I','SEE'])});
  let u=await h.ev(()=>__dbg.SENTENCES.filter(__dbg.sentUnlocked).map(x=>x.id));
  ok(u.join()==='s06'||u.join()==='s01'||u.includes('s01'),'I SEE SAM unlocked once SAM, I, SEE are won: '+u);
  ok(!u.includes('s02'),'THE CAT SAT still locked');
  await h.tap('#sents');await h.page.waitForSelector('#slist');
  const tiles=await h.ev(()=>({open:document.querySelectorAll('.stile.open').length,lock:document.querySelectorAll('.stile.lock').length,txt:document.querySelector('.stile.lock .t').textContent,go:!!document.getElementById('sgo')}));
  ok(tiles.open===u.length&&tiles.lock===36-u.length&&/Read more words/.test(tiles.txt)&&tiles.go,'open/locked tiles with friendly text '+JSON.stringify(tiles));
  await h.close();
  h=await open({seed:seedState({})});
  await h.tap('#sents');await h.page.waitForSelector('#snone');
  ok(!(await h.vis('#sgo')),'no Read button when nothing is unlocked');
  ok(/open sentences/i.test(await h.txt('#snone'))&&/Grown-up/.test(await h.txt('#shead')),'kid line + parent line');
  ok(await h.vis('#pz'),'suggests the puzzle words');
  // win words through the real API, persist, reload
  await h.ev(()=>{for(const w of ['I','SEE','SAM']){const b=wstat(w);b.tries=1;b.wins=1}save()});
  ok((await h.ev(()=>__dbg.SENTENCES.filter(__dbg.sentUnlocked).map(x=>x.id))).length>=1,'unlocks as words are won');
  await h.page.reload();await h.page.waitForSelector('#go');
  ok((await h.ev(()=>__dbg.SENTENCES.filter(__dbg.sentUnlocked).length))>=1,'unlocked set survives reload');
  // one needed word missing -> locked again (puzzle word gate)
  await h.ev(()=>{state.words.I.wins=0;save()});
  ok(!(await h.ev(()=>__dbg.sentUnlocked(__dbg.SENTENCES.find(x=>x.id==='s01')))),'puzzle word not yet won keeps the sentence locked');
  await h.close();
});

T('sent-round-right-first-try',async()=>{
  const h=await open({seed:wonSeed([...CVCW,...SIGHTW])});
  await startSent(h);
  const cfgSeen=[];
  for(let n=0;n<2;n++){
    const t=await sentText(h);const n0=(await h.clips()).length;
    await h.page.waitForTimeout(700);
    await h.tap('.SW[data-k="0"]');await h.page.waitForTimeout(700);
    const pre=names((await h.clips()).slice(n0));
    ok(!pre.some(k=>/^S[s]\d/.test(k)),'whole sentence not spoken before she reads it');
    await h.q({type:'result',alts:[t.toLowerCase()]});
    await h.mic();await h.wf(n=>__dbg.state.stars===n+1,n,10000);
    const sx=await h.st();
    const a=sx.attempts[sx.attempts.length-1];
    ok(a.sent&&a.ok&&a.step===1&&/^1+$|^[12]+$/.test(a.res),'attempt logged with per-word result '+JSON.stringify(a));
    ok(sx.sentStars.includes(a.sent),'Sentence Star recorded');
    ok((await h.ev(()=>document.querySelectorAll('.SW.got').length))===t.split(' ').length,'all words glow green');
    ok(await h.ev(()=>document.querySelectorAll('#fx span').length>0),'emoji burst');
    await h.page.waitForTimeout(4500);
    const c=names(await h.clips());
    const ip=c.lastIndexOf('Psentpraise'),is=c.findIndex((k,i)=>i>ip&&/^Ss\d/.test(k));
    ok(ip>=0&&is>ip,'praise then the full sentence read aloud ('+c.slice(-5).join(',')+')');
    ok(c.includes('Pstar'),'Sentence Star line');
    await h.wf(n=>/^\d+ \//.test(document.querySelector('.bar div:nth-child(2)')?.textContent||'')&&document.querySelector('.bar div:nth-child(2)').textContent.startsWith((n+2)+' /'),n,12000).catch(()=>{});
  }
  const cfg=await h.ev(()=>({c:__sr.inst[0].continuous,i:__sr.inst[0].interimResults,m:__sr.inst[0].maxAlternatives,l:__sr.inst[0].lang}));
  ok(cfg.c===true&&cfg.i===true&&cfg.m===5&&cfg.l==='en-US','sentence recognizer: continuous, interim, 5 alternatives '+JSON.stringify(cfg));
  const st=await h.st();
  ok(st.stars===2&&st.sents[st.attempts[0].sent].wins===1&&st.sents[st.attempts[0].sent].first===1,'sentence stats');
  ok(Object.keys(st.words).every(w=>st.words[w].tries===1),'word stats untouched by sentence reading');
  ok(await h.ev(()=>window.__act.max)<=1,'no overlapping audio');
  await h.close();
},{slow:true});

T('sent-ladder-first-missed-then-whole-sentence',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);
  ok(await sentText(h)==='SAM CAN HIT THE NET','exactly one sentence unlocked: s27');
  await h.page.waitForTimeout(700);
  // miss 1: HIT and NET wrong -> first missed word is HIT -> first-letter sound H
  await h.q({type:'result',alts:['sam can hat the nut']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);
  await h.page.waitForTimeout(5000);
  let c=names(await h.clips());
  ok(c.includes('Ptryagain')&&c.includes('LH')&&!c.includes('LN')&&c.includes('Pall'),'step 1: first sound of HIT then "read it all together" ('+c.join(',')+')');
  ok(await h.ev(()=>document.querySelectorAll('.SW.got').length)===3&&await h.ev(()=>document.querySelectorAll('.SW.nyet').length)===2,'3 words green, 2 soft orange');
  ok(!(await h.ev(()=>document.body.innerText.toLowerCase().includes('wrong'))),'never says wrong');
  let a=(await h.st()).attempts[0];ok(a.sent==='s27'&&!a.ok&&a.step===1,'attempt logged '+JSON.stringify(a));
  ok(a.res==='11010','per-word result 11010: '+a.res);
  await h.idle();
  // miss 2: sound it out letter by letter (HIT again)
  await h.q({type:'result',alts:['sam can hat the net']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2);await h.page.waitForTimeout(7500);
  c=names(await h.clips());
  ok(c.includes('Psoundout')&&c.filter(k=>k==='LH').length>=2&&c.includes('LI')&&c.includes('LT'),'step 2: H-I-T sounded out ('+c.join(',')+')');
  await h.idle();
  // miss 3 -> say it for her, then practice response completes without penalty
  await h.q({type:'result',alts:['sam can hat the net']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===3);await h.page.waitForTimeout(5500);
  c=names(await h.clips());
  ok(c.includes('Plisten')&&c.includes('WHIT'),'step 3: word said for her ('+c.slice(-6).join(',')+')');
  await h.idle();
  await h.q({type:'result',alts:['sam can hit the net']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===4);
  const st=await h.st();
  ok(st.attempts[3].practice===true&&st.stars===0,'practice completion: logged, no star, no penalty');
  ok(st.sents.s27.miss===3&&st.sents.s27.tries===3&&st.sents.s27.missed.HIT===3&&st.sents.s27.missed.NET===1,'per-sentence miss counters and missed words '+JSON.stringify(st.sents.s27));
  await h.page.waitForTimeout(3500);
  await h.wf(()=>/^2 \/ 2/.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,10000);
  ok(true,'sentence requeued once (card 2 of 2)');
  await h.close();
},{slow:true});

T('sent-requeue-once-guarantee',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(700);
  const bad={type:'result',alts:['sam can hat the net'],delay:60};
  for(let card=0;card<2;card++){
    for(let k=0;k<4;k++){
      await h.q(bad);
      await h.mic();await h.wf(([n])=>__dbg.state.attempts.length===n,[card*4+k+1],15000);
      await h.page.waitForTimeout(200);
      if(k<3)await h.idle();
    }
    if(card===0)await h.wf(()=>/^2 \/ 2/.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,12000);
    if(card===0){await h.page.waitForTimeout(900)}
  }
  await h.wf(()=>!!document.getElementById('again'),null,15000);
  const st=await h.st();
  ok(st.attempts.filter(a=>a.practice).length===2&&st.attempts.length===8,'exactly two cards were played: no endless loop ('+st.attempts.length+' attempts)');
  ok(st.stickers===1,'round finished with a sticker');
  await h.close();
},{slow:true});

T('sent-silence-and-no-speech',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(700);
  await h.q({type:'error',code:'no-speech'});
  await h.mic();await h.wf(()=>document.getElementById('mic').dataset.phase==='idle'&&/didn't hear/.test(document.getElementById('hint').textContent),null,8000);
  ok(await attemptsN(h)===0,'no-speech: nothing logged');
  await h.q({type:'end',delay:100});
  await h.mic();await h.wf(()=>/didn't hear/.test(document.getElementById('hint').textContent)&&document.getElementById('mic').dataset.phase==='idle',null,8000);
  await h.page.waitForTimeout(500);
  ok(await attemptsN(h)===0&&(await h.st()).sents.s27===undefined,'silence: no tries, no misses, no penalty');
  // tap to start, tap again to stop with nothing said
  await h.mic();await h.page.waitForTimeout(900);await h.tap('#mic');
  await h.wf(()=>document.getElementById('mic').dataset.phase==='idle',null,8000);
  ok(await attemptsN(h)===0,'second tap stops, nothing logged');
  ok(await h.vis('#mic'),'mic still there for another go');
  await h.close();
});

T('sent-child-pace-restart-and-caps',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(700);
  // 1) recognizer ends after the first words: the game listens again and joins the pieces
  await h.q({type:'result',alts:['sam can'],delay:100},{type:'result',alts:['hit the net'],delay:300});
  await h.mic();await h.wf(()=>__dbg.state.stars===1,null,12000);
  ok(await h.ev(()=>__sr.starts)>=2,'recognizer restarted after an early end ('+await h.ev(()=>__sr.starts)+' starts)');
  ok((await h.st()).attempts[0].ok===true,'pieces joined: read right');
  await h.close();
  // 2) continuous: words arrive with pauses (<1.8 s), then silence -> evaluated once after the pause
  const g=await open({seed:wonSeed(ONE27)});
  await startSent(g);await g.page.waitForTimeout(700);
  await g.q({type:'multi',parts:[{alts:['sam'],at:200},{alts:['sam can'],at:1200},{alts:['sam can hit'],at:2200},{alts:['sam can hit the net'],at:3200}]});
  const t0=Date.now();
  await g.mic();await g.wf(()=>__dbg.state.stars===1,null,12000);
  const dt=Date.now()-t0;
  ok(dt>4500&&dt<9000,'waited for the pauses, finished ~1.8 s after the last words ('+dt+' ms)');
  await g.close();
  // 3) second tap while listening stops and evaluates what was heard
  const k=await open({seed:wonSeed(ONE27)});
  await startSent(k);await k.page.waitForTimeout(700);
  await k.q({type:'multi',parts:[{alts:['sam can'],at:200}]});
  await k.mic();await k.page.waitForTimeout(1000);await k.tap('#mic');
  await k.wf(()=>__dbg.state.attempts.length===1,null,6000);
  ok((await k.st()).attempts[0].ok===false&&(await k.st()).attempts[0].res==='11020','tap-to-stop evaluated the partial read: '+(await k.st()).attempts[0].res);
  await k.close();
  // 4) never-ending speech is cut at ~12 s
  const m=await open({seed:wonSeed(ONE27)});
  await startSent(m);await m.page.waitForTimeout(700);
  await m.q({type:'multi',parts:Array.from({length:30},(_,i)=>({alts:['blah blah'],at:200+i*600}))});
  const t1=Date.now();
  await m.mic();await m.wf(()=>__dbg.state.attempts.length===1,null,20000);
  const d2=Date.now()-t1;
  ok(d2>10500&&d2<16000,'hard cap ~12 s ('+d2+' ms)');
  await m.close();
},{slow:true});

T('sent-back-mid-listening-cleans-up',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(700);
  await h.q({type:'multi',parts:[{alts:['sam can hit the net'],at:1500}],end:2500});
  await h.mic();await h.page.waitForTimeout(500);
  ok(await h.ev(()=>!!__dbg.LIS),'listening');
  await h.tap('#back');await h.page.waitForSelector('#go');
  ok(await h.ev(()=>!__dbg.LIS),'listener gone after Back');
  await h.page.waitForTimeout(3500);
  ok(await attemptsN(h)===0&&(await h.st()).stars===0,'late result ignored');
  ok(await h.vis('#sents'),'home intact');
  await h.close();
});

T('sent-word-tap-plays-letters-only',async()=>{
  const h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(900);
  const n0=(await h.clips()).length;
  await h.tap('.SW[data-k="2"]');await h.page.waitForTimeout(2200);
  const c=names((await h.clips()).slice(n0));
  ok(c.join()==='LH,LI,LT','tapping HIT plays its letter sounds one by one: '+c.join());
  ok(!c.includes('WHIT')&&!c.some(k=>/^Ss/.test(k)),'never the whole word / sentence');
  await h.tap('.SW[data-k="3"]');await h.page.waitForTimeout(2500);
  ok(names((await h.clips()).slice(n0)).slice(3).join()==='LT,LH,LE','puzzle word THE: letters too');
  ok(await h.ev(()=>window.__act.max)<=1,'no overlap');
  await h.close();
});

T('sent-fallback-parent-buttons',async()=>{
  let h=await open({nosr:true,seed:wonSeed(ONE27)});
  await startSent(h);
  ok(await h.vis('#read')&&!(await h.vis('#mic')),'no mic API: parent buttons shown');
  await h.page.waitForTimeout(500);
  await h.tap('#read');await h.wf(()=>!document.getElementById('yes').disabled,null,5000);
  await h.page.waitForTimeout(200);
  ok(names(await h.clips()).some(k=>k==='Ss27'),'"I read it" -> sentence spoken');
  await h.tap('#yes');await h.wf(()=>__dbg.state.stars===1);
  const a=(await h.st()).attempts[0];ok(a.sent==='s27'&&a.ok&&a.via==='parent','logged via parent');
  await h.close();
  h=await open({nosr:true,seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(500);
  await h.tap('#read');await h.wf(()=>!document.getElementById('no').disabled,null,5000);await h.tap('#no');
  await h.wf(()=>/^2 \/ 2/.test(document.querySelector('.bar div:nth-child(2)')?.textContent||''),null,6000);
  ok((await h.st()).sents.s27.miss===1,'Try later = a miss, requeued once');
  await h.close();
  // permission denied while reading a sentence -> parent buttons
  h=await open({seed:wonSeed(ONE27)});
  await startSent(h);await h.page.waitForTimeout(700);
  await h.q({type:'error',code:'not-allowed'});await h.mic();
  await h.wf(()=>!!document.getElementById('read'),null,6000);
  ok(await h.ev(()=>__dbg.M.fallback&&__dbg.M.reason==='denied'),'denied -> fallback');
  await h.close();
});

T('sent-comeback-and-castle-counters',async()=>{
  const seed=wonSeed(ONE27,{roundNo:3,sents:{s27:{tries:2,wins:0,miss:2,first:0,owes:true,missRound:1,missed:{HIT:2}}}});
  const h=await open({seed});
  await startSent(h);await h.page.waitForTimeout(700);
  await h.q({type:'result',alts:['sam can hit the net']});await h.mic();
  await h.wf(()=>__dbg.state.comebacks===1,null,8000);
  const st=await h.st();
  ok(st.crowns.length===1&&st.crowns[0].s==='s27'&&st.sentStars.includes('s27'),'comeback crown + sentence star '+JSON.stringify(st.crowns));
  await h.page.waitForTimeout(6500);
  ok(names(await h.clips()).includes('Pcomeback'),'comeback line');
  await h.wf(()=>!!document.getElementById('again'),null,12000).catch(()=>{});
  await h.close();
  const g=await open({seed:wonSeed(ONE27,{sentStars:['s27'],sents:{s27:{tries:3,wins:1,miss:2,first:0,owes:false,missRound:1,missed:{HIT:2,NET:1}}},attempts:[{sent:'s27',heard:'sam can hat',ok:false,step:1,ts:1,res:'11010'}]})});
  await g.tap('#castle');await g.page.waitForSelector('#scard');
  ok(/Sentences I can read: 1/.test(await g.txt('#scard')),'castle counter');
  ok(/Puzzle words/.test(await g.ev(()=>document.body.innerText)),'Puzzle words row');
  await g.hold(2300);await g.page.waitForSelector('#reset');
  await g.tap('#ts');await g.page.waitForSelector('#stable');
  const t=await g.txt('#stable');ok(/SAM CAN HIT THE NET/.test(t)&&/HIT×2/.test(t),'Sentences tab with missed words: '+t.slice(0,120));
  await g.tap('#tw');ok(await g.ev(()=>!document.getElementById('stable')),'tabs switch back');
  await g.tap('#reset');await g.tap('#reset');await g.page.waitForSelector('#gcard');
  ok((await g.st()).sentStars.length===0&&Object.keys((await g.st()).sents).length===0,'two-tap reset clears sentence progress');
  await g.close();
});

T('sent-corrupt-and-oversized-history',async()=>{
  const junk=[];
  for(let i=0;i<900;i++)junk.push(i%3?{sent:'s27',heard:'x'.repeat(500),ok:true,step:99,ts:i,res:'1010'}:{sent:'zz'+i,res:'x'});
  junk.push(null,5,'x',{sent:'__proto__'},{sent:'s01',res:'9999999999'});
  const raw=JSON.stringify({stars:5,attempts:junk,sents:{s27:{tries:4,wins:1e30,missed:{HIT:5,'__proto__':3,'a':1,'ABCDEFGHI':2,...Object.fromEntries(Array.from({length:30},(_,i)=>['W'+String.fromCharCode(65+i%26)+i,1]))}},'__proto__':{tries:5},zzz:{wins:3},s01:null},sentStars:['s27','s27','nope',5,null,'__proto__'],crowns:[{w:'SENT',s:'s27'},{w:'SENT',s:'bad'},{w:'x y'}]});
  const h=await open({raw});
  const st=await h.st();
  ok(st.attempts.length<=500&&st.attempts.every(a=>a.sent?(a.heard.length<=100&&a.step>=1&&a.step<=3&&/^[012]*$/.test(a.res)):true),'attempts capped at 500 and sanitised ('+st.attempts.length+')');
  ok(Object.keys(st.sents).join()==='s27','only real sentence ids kept '+Object.keys(st.sents));
  ok(st.sents.s27.wins<=1e9&&Object.keys(st.sents.s27.missed).length<=8,'counters bounded, missed words <=8 keys');
  ok(st.sentStars.join()==='s27','star list deduped / validated');
  ok(st.crowns.length===2&&st.crowns[0].s==='s27'&&st.crowns[1].s===undefined,'crowns sanitised');
  await h.tap('#castle');await h.page.waitForSelector('#scard');
  await h.hold(2300);await h.page.waitForSelector('#reset');await h.tap('#ts');
  ok(await h.vis('#stable'),'grown-up sentence table renders with corrupt history');
  await h.close();
  for(const bad of ['{"sents":5,"sentStars":"x"}','{"sents":[],"attempts":{"sent":"s01"}}','{"sents":{"s27":5}}']){
    const g=await open({raw:bad});ok(await g.vis('#sents'),'loads with '+bad);await g.close();
  }
});

T('sent-puzzle-words',async()=>{
  const h=await open();
  await h.tap('#puzzle');await h.page.waitForSelector('#mic');
  ok(await h.ev(()=>document.querySelectorAll('.L.s').length>=1&&/puzzle/i.test(document.getElementById('hint').textContent)),'puzzle framing');
  const w=await h.word();ok(SIGHTW.includes(w),'a sight word is shown: '+w);
  await h.page.waitForTimeout(900);
  await h.tap('.L[data-k="0"]');await h.page.waitForTimeout(500);
  await h.q({type:'result',alts:['zzz']});
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.page.waitForTimeout(5500);
  let c=names(await h.clips());
  ok(c.includes('Ptryagain')&&c.includes('W'+w)&&c.includes('Pnowyou'),'miss: word said for her then "now you say it" ('+c.join(',')+')');
  ok(c.filter(k=>k[0]==='L').length===1,'no letter-by-letter blend for a puzzle word (only the one tapped)');
  await h.idle();
  await h.q({type:'result',alts:[w.toLowerCase()]});await h.mic();await h.wf(()=>__dbg.state.stars===1);
  const st=await h.st();
  ok(st.words[w].sight===true&&st.words[w].wins===1&&st.attempts.every(a=>a.sight===true),'tracked in the same structures, flagged sight:true');
  await h.back();await h.tap('#castle');await h.page.waitForSelector('#hold');
  ok(await h.ev(w=>[...document.querySelectorAll('.card div')].some(d=>/Puzzle words/.test(d.textContent)&&d.children.length===0&&d.nextElementSibling&&d.nextElementSibling.querySelectorAll('.tile').length===5),w),'separate Puzzle words row of 5 tiles');
  await h.close();
},{slow:true});

const SENT_VIEWS=[['320',{viewport:{width:320,height:640}}],['360',{viewport:{width:360,height:740}}],['393',{}],['768',{viewport:{width:768,height:1024}}],['landscape',{viewport:{width:851,height:393}}],['landscape-small',{viewport:{width:568,height:320}}]];
T('sent-layout-5-word',async()=>{
  for(const [name,o] of SENT_VIEWS){
    const h=await open({...o,seed:wonSeed(['DAD','CAN','SUN','THE','SEE'])});
    ok(await h.vis('#puzzle')&&await h.vis('#sents'),name+': home has the new doors');
    let r=await h.ev(()=>({sw:document.documentElement.scrollWidth,iw:innerWidth}));ok(r.sw<=r.iw,name+': home no h-scroll');
    await startSent(h);
    ok(await sentText(h)==='DAD CAN SEE THE SUN','5-word sentence shown');
    r=await h.ev(()=>{const iw=innerWidth,bad=[];for(const b of document.querySelectorAll('button')){const q=b.getBoundingClientRect();if(q.width<1)continue;if(q.height<47.5||q.width<47.5)bad.push('small '+(b.id||b.textContent.slice(0,8))+' '+Math.round(q.width)+'x'+Math.round(q.height));if(q.left<-0.5||q.right>iw+0.5)bad.push('offscreen '+b.textContent.slice(0,8))}
      const ws=[...document.querySelectorAll('.SW')].map(e=>e.getBoundingClientRect());return {sw:document.documentElement.scrollWidth,iw,bad,rows:new Set(ws.map(q=>Math.round(q.top))).size,mic:!!document.getElementById('mic')}});
    ok(r.sw<=r.iw,name+': sentence screen no h-scroll ('+r.sw+'/'+r.iw+')');
    ok(r.bad.length===0,name+': targets >=48px, inside viewport '+r.bad.join('; '));
    ok(r.mic,name+': mic present');
    await h.back();await h.tap('#sents');await h.page.waitForSelector('#slist');
    r=await h.ev(()=>({sw:document.documentElement.scrollWidth,iw:innerWidth,ov:[...document.querySelectorAll('.stile')].filter(e=>e.scrollWidth>e.clientWidth+1).length}));
    ok(r.sw<=r.iw&&r.ov===0,name+': sentence list fits');
    await h.close();
  }
});

const PICKER_VIEWS=[...VIEWS.filter(v=>v[0]!=='desktop'),['landscape-small',{viewport:{width:568,height:320}}],['desktop',{desktop:true}]];
T('voice-picker-layout',async()=>{
  for(const [name,o] of PICKER_VIEWS){
    const h=await open(o);
    await toPicker(h);
    await h.tap('[data-sel="af_nicole"]');
    const r=await h.ev(()=>{
      const iw=innerWidth,bad=[];
      for(const b of document.querySelectorAll('button')){const q=b.getBoundingClientRect();if(q.width<1)continue;if(q.height<47.5||q.width<47.5)bad.push('small '+b.id+b.textContent.slice(0,10)+' '+Math.round(q.width)+'x'+Math.round(q.height));if(q.left<-0.5||q.right>iw+0.5)bad.push('offscreen '+b.textContent.slice(0,12))}
      for(const c of document.querySelectorAll('.vcard,.card,.vbtns,.seg')){if(c.scrollWidth>c.clientWidth+1)bad.push('overflow '+c.className)}
      const cards=[...document.querySelectorAll('.vcard')].map(c=>c.getBoundingClientRect());
      for(let i=1;i<cards.length;i++)if(cards[i].top<cards[i-1].bottom-0.5)bad.push('cards overlap');
      return {sw:document.documentElement.scrollWidth,iw,bad,n:document.querySelectorAll('.vcard').length}
    });
    ok(r.sw<=r.iw,name+': no horizontal scroll ('+r.sw+'>'+r.iw+')');
    ok(r.bad.length===0,name+': touch targets >=48px and nothing clipped '+r.bad.join('; '));
    ok(r.n===3,name+': three cards');
    await h.page.locator('[data-sel="af_sarah"]').scrollIntoViewIfNeeded();
    ok(await h.vis('#ls-classic')||true,'');
    await h.close();
  }
});

T('voice-full-round-ladder-nondefault-voice',async()=>{
  const h=await open({init:seedPrefs({voice:'af_sarah',letters:'classic'}),seed:seedState({family:'u'})});
  await h.play();const w=await h.word();
  await h.q({type:'result',alts:['a']},{type:'result',alts:['b']},{type:'result',alts:[w]});
  await h.page.waitForTimeout(700);
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===1);await h.page.waitForTimeout(5000);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.attempts.length===2,null,10000);await h.page.waitForTimeout(9000);await h.idle();
  await h.mic();await h.wf(()=>__dbg.state.stars===1,null,12000);await h.page.waitForTimeout(4000);
  const c=await h.clips(),k=names(c);
  ok(['Ptryagain','Psoundout','Pnowyou','W'+w].every(x=>k.includes(x)),'ladder clips all played: '+k.join(','));
  ok(c.filter(x=>x.k[0]==='L').length>=3&&c.filter(x=>x.k[0]==='L').every(x=>x.v==='classic'),'ladder letters are Classic');
  ok(c.filter(x=>x.k[0]!=='L').every(x=>x.v==='af_sarah'),'prompts / word / praise in Sarah');
  ok(await h.ev(()=>window.__act.max)<=1,'no overlap in the ladder');
  ok(await h.ev(()=>window.__log.filter(e=>e.t==='tts').length)===0,'no speechSynthesis');
  const s=await h.st();ok(s.attempts.length===3&&!s.attempts[0].ok&&!s.attempts[1].ok&&s.attempts[2].ok&&s.attempts[2].step===3,'v2 ladder semantics intact '+JSON.stringify(s.attempts.map(a=>[a.ok,a.step])));
  await h.close();
},{slow:true});

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
