import subprocess,wave,numpy as np,json,os,re,base64,sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))  # run from anywhere
os.makedirs('clips',exist_ok=True);os.makedirs('t',exist_ok=True)
def espeak(t,sp,pi=55,vo='en-us+f3',out='t/x.wav'):
    subprocess.run(['espeak-ng','-v',vo,'-s',str(sp),'-p',str(pi),'-a','180','-w',out,t],check=True)
    w=wave.open(out);a=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).astype(float)/32768;return a,w.getframerate()
FR=0.01
def rms(a,sr):
    n=int(sr*FR);return np.array([np.sqrt(np.mean(a[i:i+n]**2)) for i in range(0,len(a)-n,n)])
def lead(a,sr,th=0.02):
    r=rms(a,sr);i=np.argmax(r>th);return a[i*int(sr*FR):],sr
def onset(a,sr):
    r=rms(a,sr);base=np.mean(r[:2]) if r[0]>0 else r[2]
    for f in range(2,len(r)):
        if r[f]>2.2*base and r[f]>0.1*r.max(): return f
    return len(r)//2
def fade(a,sr,fi=0.004,fo=0.02):
    a=a.copy();n=int(sr*fi);m=int(sr*fo)
    if n and len(a)>n:a[:n]*=np.linspace(0,1,n)
    if len(a)>m:a[-m:]*=np.linspace(1,0,m)
    return a
# (symbol, kind, extra frames)
STOP={'B':'b','D':'d','G':'g','P':'p','T':'t','K':'k','C':'k','J':'dZ'}
SONOR={'L':'l','M':'m','N':'n','R':'r','W':'w','Y':'j'}
FRIC={'F':'f','H':'h','S':'s','V':'v','Z':'z'}
VOW={'A':'a','E':'E','I':'I','O':'0','U':'V'}
clipsA={}
def cons(sym,kind,sp=90):
    a,sr=espeak('[['+sym+'@]]',sp);a,sr=lead(a,sr);f=onset(a,sr);n=int(sr*FR)
    if kind=='stop': end=(f+3)*n
    elif kind=='fric': end=max(f-1,10)*n
    else: end=(f+(4 if sym in 'wjrl' else -2))*n
    seg=a[:end]
    mx=int(sr*{'stop':0.16,'fric':0.4,'son':0.4}[kind]); seg=seg[:mx]
    return seg,sr
for k,s in STOP.items(): clipsA[k]=cons(s,'stop')
for k,s in SONOR.items(): clipsA[k]=cons(s,'son')
for k,s in FRIC.items(): clipsA[k]=cons(s,'fric')
for k,s in VOW.items():
    a,sr=espeak('[['+s+']]',100);a,sr=lead(a,sr);a=a[:int(sr*0.42)];clipsA[k]=(a,sr)
for k,t in (('S','ssss'),('F','ffff')):
    a,sr=espeak('[['+t+']]',90);a,sr=lead(a,sr,0.01);clipsA[k]=(a[:int(sr*0.36)],sr)
# compound
k_,sr=clipsA['K'];w_,_=clipsA['W'];clipsA['Q']=(np.concatenate([k_,w_[:int(sr*0.22)]]),sr)
s_,_=clipsA['S'];clipsA['X']=(np.concatenate([k_,s_[:int(sr*0.25)]]),sr)

def wr(a,sr,path):
    a=fade(a,sr);r=np.sqrt(np.mean(a**2))+1e-9;a=a*(0.13/r);a=np.tanh(a*1.2)/1.2
    a=np.clip(a,-.97,.97)
    w=wave.open(path,'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes((a*32767).astype(np.int16).tobytes());w.close()
def enc(wav,mp3):
    subprocess.run(['ffmpeg','-y','-loglevel','error','-i',wav,'-ar','22050','-ac','1','-c:a','libmp3lame','-b:a','32k',mp3],check=True)
for k,(a,sr) in clipsA.items():
    wr(a,sr,'clips/L%s.wav'%k);enc('clips/L%s.wav'%k,'clips/L%s.mp3'%k)
    print(k,round(len(a)/sr,3),end=' | ')
print()
html=open('castle.src.html').read()
words=sorted(set(re.findall(r'"([A-Z]{3})"',html.split('const PIC')[0])))
phr={'praise0':'Great reading, Julia!','praise1':'You did it, Princess!','praise2':'Royal reader!','praise3':'Brilliant, Julia!','praise4':'Hooray!',
 'praise5':'Super star, Julia!','praise6':'Magnificent, Princess Julia!','praise7':'Wonderful reading, Julia!',
 'done':'Well done, Princess Julia! You earned a sticker!','hello':'Hello Julia',
 # v2 (microphone game)
 'say':'Say the word!','nohear':"I didn't hear you. Tap and try again!",'tryagain':"Hmm, let's try again!",
 'soundout':"Let's sound it out together.",'nowyou':'Now you say it!','listen':'Listen.',
 'practice':'Great practice, Julia!','comeback':'You got a comeback crown!','room':'A new room in your castle!'}
jobs={'W'+w:w.lower() for w in words};jobs['WJULIA']='Julia'
for k,v in phr.items(): jobs['P'+k]=v
for k,t in jobs.items():
    a,sr=espeak(t,125,60);a,sr=lead(a,sr)
    r=rms(a,sr);idx=np.where(r>0.02)[0];a=a[:(idx[-1]+2)*int(sr*FR)]
    wr(a,sr,'clips/%s.wav'%k);enc('clips/%s.wav'%k,'clips/%s.mp3'%k)
out={}
keep=set(['L'+c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'])|set(jobs)
for f in os.listdir('clips'):
    if f.endswith('.mp3') and f[:-4] in keep: out[f[:-4]]=base64.b64encode(open('clips/'+f,'rb').read()).decode()
json.dump(out,open('clips.json','w'),separators=(',',':'))
print(len(out),sum(len(v) for v in out.values()))
