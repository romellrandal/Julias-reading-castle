"""Build index.html from tools/castle.src.html + the audio packs.

  tools/clips.json            "Classic" espeak clips (made by gen2.py): letter sounds + the old words / phrases
  tools/clips_<voice>.json    one Kokoro voice pack each (made by gen_kokoro.py), voices listed in tools/phrases.json
The build FAILS if any id in tools/phrases.json is missing from any voice pack, or if the Classic set lacks a letter /
word / phrase the game needs.
"""
import json,os,re,shutil,subprocess,sys
here=os.path.dirname(os.path.abspath(__file__))
root=os.path.dirname(here)
s=open(os.path.join(here,'castle.src.html'),encoding='utf-8').read()
r=subprocess.run([sys.executable,os.path.join(here,'check_sentences.py')],capture_output=True,text=True);print(r.stdout.strip())
if r.returncode: print(r.stderr);sys.exit(1)
man=json.load(open(os.path.join(here,'phrases.json'),encoding='utf-8'))
ids=[k for sec in ('letters','words','phrases','sentences') for k in man[sec]]
classic=json.load(open(os.path.join(here,'clips.json')))
bad=[]
for k in ids:
    if k[0] in 'LWP' and k not in classic: bad.append('classic pack lacks '+k)
voices={}
for v in man['voices']:
    p=os.path.join(here,'clips_%s.json'%v['id'])
    if not os.path.exists(p): bad.append('missing pack file '+p); continue
    pack=json.load(open(p))
    for k in ids:
        if not isinstance(pack.get(k),str) or not pack[k]: bad.append('%s lacks %s'%(v['id'],k))
    voices[v['id']]=pack
if bad:
    print('BUILD FAILED:');print('\n'.join('  '+b for b in bad));sys.exit(1)
bundle={'classic':classic,'voices':voices,'meta':[{'id':v['id'],'name':v['name'],'blurb':v['blurb']} for v in man['voices']]}
blob=json.dumps(bundle,separators=(',',':')).replace('</','<\\/')
assert s.count('__CLIPS__')==1 and s.count('__SENTENCES__')==1
sents=json.dumps(json.load(open(os.path.join(here,'sentences.json'),encoding='utf-8')),ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
out=s.replace('__CLIPS__',blob).replace('__SENTENCES__',sents)
open(os.path.join(root,'index.html'),'w',encoding='utf-8').write(out)
print('index.html',len(out.encode()),'bytes')
print('  classic %d KB'%(len(json.dumps(classic,separators=(',',':')))//1024),*['%s %d KB'%(k,len(json.dumps(v,separators=(',',':')))//1024) for k,v in voices.items()])
if shutil.which('node'):  # syntax check of the page script
    m=re.findall(r'<script>(.*?)</script>',out,re.S)
    tmp=os.path.join(here,'t','_chk.js');os.makedirs(os.path.dirname(tmp),exist_ok=True);open(tmp,'w',encoding='utf-8').write(m[-1])
    r=subprocess.run(['node','--check',tmp],capture_output=True,text=True);os.remove(tmp)
    if r.returncode: print('node --check FAILED\n'+r.stderr);sys.exit(1)
    print('node --check ok')
