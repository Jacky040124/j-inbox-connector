// An email made dark in place, inside the frame's one script (email-frame.ts). It is JS as a string, never a
// compiled function's toString(): the Worker's bundler adds helpers to those that do not exist in the frame. It is
// a plain template with no tag, no backslash and no substitution, so that dist/email-frame.js, which has no use
// for it, shakes it out (build.ts checks). Nothing in here may hold a closing script tag or the words of a comment open.
//
// From what the browser computed, not from the email's source. Only neutral light backgrounds turn dark; anything
// else, an image, a gradient, a colour, a dark one, is kept with all inside it, as a card on the pane. A kept
// area's text is what the sender set, so its colour is written where it starts or it would inherit a flipped one.
// All is read first and written once, after a verdict. A wrong dark email is worse than a white one, so what cannot
// be told means paper, today's white look, with not one write done: a walk over budget or cap, kept text too faint to
// read, a throw, and sized text that seems hidden or overlaps something that keeps its paint, as the eye may see otherwise.
//
// Email markup can name things: <img name=body> takes document.body, and a form's fields take its own properties.
// So what this needs of document and window it holds from here, before the email exists, and the walk goes by a
// TreeWalker, which is iterative as well. A form's field can still get in the way of an element's own property (the
// sanitizer leaves no forms, lock three may meet one): that throws and comes out as paper, what was written undone.
//
// Known limits, on purpose: a sender can put any words in plain sight, so revealing words hidden by an odd trick gains
// nothing; the goal is readable mail and no new way to hang the tab. Not caught: covers made with thick borders, offset
// box-shadows or small inset shadows; a sender's own dark version with under 5% faint text, if its rules are paint only.
//
// Own dark mode: the sanitizer keeps @media (prefers-color-scheme: dark), and most of the mail with such rules ends
// up as light text on its white table. So they are measured with the rules on, and taken at their word only if
// readable; otherwise they are rewritten away through the CSSOM. Chromium answers matchMedia in a frame from the
// iframe element's color-scheme, and not at once, WebKit from the system. So what is decided is what matchMedia says
// here and now, and it is then written into the rules, to stand whatever matchMedia says later. Taken at their word,
// they must also show the same words as the light version, as agents and light mode read those, and their rules may
// only paint (a display that moves no words aside), with no rule about width, so that nothing needs reading again.
export const EMAIL_FRAME_DARK_SOURCE = `
var gcs=w.getComputedStyle.bind(w),tree=d.createTreeWalker.bind(d),mk=d.createElement.bind(d),rng=d.createRange.bind(d),sheets=d.styleSheets,Pic=w.Image,mm=w.matchMedia?w.matchMedia.bind(w):null,q=mm?mm("(prefers-color-scheme: dark)"):null;
var WHITE=[255,255,255],SURFACE=[31,31,31],MAX_ELEMENTS=8000,flipBudgetMs=150,MAX_BAD=0.05,MAX_READS=32,MAX_PLATE_WIDTH=320,MAX_READ_PIXELS=2e6,READ_MS=4000,SIDE=48,TINY=3,BIG_SHADOW=8,CELL=64,SLICE_MS=8,MAX_MARKS=64,RE_DRESS_MS=100,MAX_CHANGES=2;
var NO_STYLE=/^(HEAD|STYLE|SCRIPT|TITLE|META|LINK|BASE)$/,SCHEME=/prefers-color-scheme/i,DARK_Q=/[(] *prefers-color-scheme *: *dark *[)]/gi,LIGHT_Q=/[(] *prefers-color-scheme *: *light *[)]/gi,PX=/-?[0-9.]+px/g,PAINT=/^(color|color-scheme|display|background(-.*)?|border-[a-z-]*color|outline-color|text-decoration-color|caret-color|fill|stroke|-webkit-text-fill-color)$/;
// Conditions rather than "not all" and "all", or a rule that also asks for a width would lose that.
var NEVER="(min-width:99999999px)",ALWAYS="(min-width:0)";
var seen=new Map(),ink=null,until=0,undo=[];
// Computed style can say color(...), oklch(...), lab(...): a canvas turns any of them to sRGB. null: this engine will not say.
function painted(v){try{if(!ink){var e=mk("canvas");e.width=e.height=1;ink=e.getContext("2d",{willReadFrequently:true})}ink.fillStyle="#000";ink.fillStyle=v;var a=ink.fillStyle;ink.fillStyle="#fff";ink.fillStyle=v;if(a!==ink.fillStyle)return null;ink.clearRect(0,0,1,1);ink.fillRect(0,0,1,1);var p=ink.getImageData(0,0,1,1).data;return[p[0],p[1],p[2],p[3]/255]}catch(x){return null}}
function parse(v){var c=seen.get(v);if(c!==undefined)return c;var m=/^rgba?[(] *([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)(?:[ ,/]+([0-9.e+-]+))? *[)]$/.exec(v);c=m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]]:painted(v);seen.set(v,c);return c}
function css(c){return"rgb("+(c[0]|0)+","+(c[1]|0)+","+(c[2]|0)+")"}
function blend(c,u){var a=c[3]===undefined?1:c[3];return[c[0]*a+u[0]*(1-a),c[1]*a+u[1]*(1-a),c[2]*a+u[2]*(1-a)]}
function lin(x){x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)}
function lum(c){return 0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2])}
function contrast(a,u){var x=lum(a),y=lum(u);return(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}
function hsl(c){var r=c[0]/255,g=c[1]/255,u=c[2]/255,M=Math.max(r,g,u),m=Math.min(r,g,u),l=(M+m)/2,e=M-m,t=0;if(e)t=M===r?((g-u)/e+6)%6:M===g?(u-r)/e+2:(r-g)/e+4;return[t*60,e?e/(1-Math.abs(2*l-1)):0,l]}
function rgb(t,s,l){var a=s*Math.min(l,1-l);function f(n){var k=(n+t/30)%12;return 255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))}return[f(0),f(8),f(4)]}
function isLight(c){return lum(c)>=0.6}
function neutral(c){return hsl(c)[1]<0.18||Math.max(c[0],c[1],c[2])-Math.min(c[0],c[1],c[2])<16}
// White is the pane; an off-white a step lighter, so that a white card on a grey page keeps its depth.
function mapBg(c){var l=lum(c);if(l>=0.97)return SURFACE;var s=Math.min(14,6+(1-l)*40);return[SURFACE[0]+s,SURFACE[1]+s,SURFACE[2]+s]}
// Very dark tinted text is neutral too: dark teal otherwise comes out bright teal.
function mapText(c,u){if(neutral(c)||lum(c)<0.05){var x=227-lum(c)*220,g=[x,x,x];while(contrast(g,u)<4.5&&g[0]<255)g=[g[0]+8,g[1]+8,g[2]+8];return[Math.min(255,g[0]),Math.min(255,g[1]),Math.min(255,g[2])]}var a=hsl(c),s=Math.min(a[1],0.9),l=a[2],o=rgb(a[0],s,l);while(contrast(o,u)<4.5&&l<0.95){l+=0.03;o=rgb(a[0],s,l)}return o}
// A computed text-shadow or box-shadow, each of its layers. null: a colour this engine will not say.
function shadows(v){if(!v||v==="none")return[];var a=v.split(/,(?![^(]*[)])/),o=[];for(var i=0;i<a.length;i++){var m=a[i].match(PX)||[],c=parse(a[i].replace(PX,"").replace("inset","").trim());if(!c)return null;o.push({c:c,x:parseFloat(m[0])||0,y:parseFloat(m[1])||0,s:parseFloat(m[3])||0,inset:a[i].indexOf("inset")>=0})}return o}
var schemed=null,asks=[],widths=[],tooWide=false,marks=null;
function rules(f){var i,j,r,t=[],l;for(i=0;i<sheets.length;i++)try{r=sheets[i];if(r.media)f(r);t.push(r.cssRules)}catch(x){}while(t.length){l=t.pop();for(j=0;l&&j<l.length;j++)try{r=l[j];if(r.media&&r.cssRules)f(r);if(r.cssRules)t.push(r.cssRules)}catch(x){}}}
function calmed(t){return t.replace(DARK_Q,NEVER).replace(LIGHT_Q,ALWAYS)}
// What the sheets ask of the colour scheme, as written, so that it can be turned either way, and of the width.
function scan(){if(schemed)return;schemed=[];rules(function(r){var t=r.media.mediaText;if(SCHEME.test(t)){schemed.push(r.media,t);asks.push(r)}if(t.indexOf("width")>=0&&widths.indexOf(calmed(t))<0){if(widths.length<MAX_MARKS)widths.push(calmed(t));else tooWide=true}})}
// Do the rules for a colour scheme only paint? Out of time means no.
function paintOnly(){
  var t=asks.slice(),n=0,r,l,j,i;
  while(t.length){
    r=t.pop();
    if(r.style)for(i=0;i<r.style.length;i++){if(!PAINT.test(r.style[i]))return false;if((++n&255)===0&&Date.now()>until)return false}
    l=r.cssRules;
    for(j=0;l&&j<l.length;j++)t.push(l[j]);
  }
  return true;
}
function hasOwnDark(){for(var i=1;i<schemed.length;i+=2)if(schemed[i].search(DARK_Q)>=0)return true;return false}
function settle(dark){scan();for(var i=0;i<schemed.length;i+=2)try{schemed[i].mediaText=dark?schemed[i+1].replace(DARK_Q,ALWAYS).replace(LIGHT_Q,NEVER):calmed(schemed[i+1])}catch(x){}}
// The light version, whatever this engine thinks of the frame.
function calm(){settle(false)}
var SIDES=["top","right","bottom","left"];
// One element: what its children stand on (o: as sent, n: as painted now), and its writes. k: in a kept area. u: on a picture, what it shows nobody can measure. pl: all of it painted as sent. g: gone from view, with all inside it. h: this one's own text hidden. b: its text too faint. d: cannot tell. w: its words show, for comparing two versions.
function enter(e,p,R){
  var s={o:p.o,n:p.n,k:p.k,u:p.u,pl:p.pl,g:p.g,h:p.g,b:false,d:false,w:false,x:false},tag=e.nodeName,W=R.w;
  if(NO_STYLE.test(tag)){s.g=s.h=s.x=true;return s}
  var cs=gcs(e),size=parseFloat(cs.fontSize);
  // A font size of 0 is how fluid columns close their gaps: it hides this one's own text, never what sets a size of its own.
  s.g=p.g||cs.display==="none"||cs.opacity==="0"||(cs.maxHeight==="0px"&&cs.overflowY==="hidden");
  var gone=s.g||cs.visibility!=="visible";
  s.h=gone||size===0;
  function keep(){W.push(e,"color",cs.color,e,"color-scheme","light");if(!gone)R.ob.push(e)}
  var c=parse(cs.backgroundColor),col=parse(cs.color),im=cs.backgroundImage,over,i,x;
  if(!c){R.d++;c=[0,0,0,0]}
  if(!col){R.d++;col=[32,33,36,1]}
  if(/text/.test(cs.backgroundClip)&&!gone)R.d++;
  var bs=shadows(cs.boxShadow);
  if(!bs){R.d++;bs=[]}
  // An inset shadow that fills the box is its background; a wide outer one covers what is around it.
  for(i=bs.length-1;i>=0;i--){x=bs[i];if(x.inset&&x.c[3]>0&&Math.max(Math.abs(x.x),Math.abs(x.y),x.s)>=BIG_SHADOW){c=blend(x.c,c[3]>0?blend(c,p.o):p.o).concat(1);im="none"}else if(!x.inset&&x.s>=BIG_SHADOW&&!R.own&&!gone)R.d++}
  var tint=c[3]>0,solid=c[3]>=1;
  if(tag==="HR"&&!p.k&&tint&&neutral(over=blend(c,p.o))){W.push(e,"background-color",contrast(over,p.o)<1.3?css(p.n):isLight(over)?"#3c4043":"#5f6368")}
  else if(im&&im!=="none"){
    s.k=s.u=true;
    if(p.k){s.o=s.n=solid?c:tint?blend(c,p.n):p.n;s.pl=p.pl||solid}
    else{
      keep();
      over=tint?blend(c,p.o):p.o;
      // Until it loads, or if it never does, the picture is whatever is under it. Text that would not read on the pane keeps what it sat on; so does text hidden there, or the pane would show it.
      if(solid){s.o=s.n=c;s.pl=true}
      else if(contrast(blend(col,over),over)<1.3||contrast(blend(col,p.n),p.n)<3){W.push(e,"background-color",css(over));s.o=s.n=over;s.pl=true}
      else s.o=s.n=tint?blend(c,p.n):p.n;
    }
  }else if(c[3]>0.01){
    if(p.k){s.o=s.n=blend(c,p.n);s.u=p.u&&c[3]<1;s.pl=p.pl&&c[3]<1}
    else{
      over=blend(c,p.o);
      if(isLight(over)&&neutral(over)){s.o=over;s.n=mapBg(over);W.push(e,"background-color",css(s.n))}
      // A tint with alpha was meant over what it sat on, not over the pane.
      else{s.o=s.n=over;s.k=true;keep();if(c[3]<1||bs.length)W.push(e,"background-color",css(over))}
    }
  }
  var tiny=size<=TINY;
  if(s.k){
    var ct=contrast(blend(col,s.n),s.n);
    s.b=R.own?s.u||ct<3:!s.pl&&ct<3;
    s.w=!s.h&&!tiny&&(s.u||ct>=1.3);
    return s;
  }
  var fg=blend(col,s.o),near=contrast(fg,s.o)<1.3;
  var ts=shadows(cs.textShadow);
  if(!ts){R.d++;ts=[]}
  if(near){
    // A shadow that shows under text that does not is the text. Otherwise tiny is a preheader, and stays hidden; sized, it may be what a reader sees by a means not read here.
    var most=1.3,b=null;
    for(i=0;i<ts.length;i++)if(ts[i].c[3]>0.1){x=blend(ts[i].c,s.o);if(contrast(x,s.o)>=most){most=contrast(x,s.o);b=x}}
    if(b){fg=b;near=false}else if(!tiny)s.d=true;
  }
  W.push(e,"color",css(near?s.n:mapText(fg,s.n)));
  if(cs.textShadow!=="none")W.push(e,"text-shadow","none");
  if(cs.boxShadow!=="none")W.push(e,"box-shadow","none");
  for(i=0;i<4;i++){
    var n="border-"+SIDES[i]+"-";
    var bw=parseFloat(cs.getPropertyValue(n+"width"));
    if(bw>0&&cs.getPropertyValue(n+"style")!=="none"){
      var bc=parse(cs.getPropertyValue(n+"color"));
      // One that did not show is spacing, and still does not, as a wide pale one would paint a bar; a hairline of #eee is a rule. A coloured one is the sender's.
      if(bc&&bc[3]>0){over=blend(bc,s.o);x=contrast(over,s.o);if(x<1.05||(x<1.3&&bw>2))W.push(e,n+"color",css(s.n));else if(neutral(over))W.push(e,n+"color",isLight(over)?"#3c4043":"#5f6368")}
    }
  }
  if(tag==="IMG"){R.p.push(e,css(s.o));if(!gone)R.ob.push(e)}
  return s;
}
// Reads only: the whole email from the root, by a stack of its own. own: all is kept as it stands, on the canvas given, and what shows is written down.
function walk(root,own){
  var t=tree(h,5),R={w:[],p:[],ob:[],tx:[],c:0,b:0,d:0,v:"",root:null,over:false,own:own},st=[],N=1,go=0,n,s;
  s=own?root:enter(h,root,R);
  R.root=s;
  st.push(s);
  function visit(x){
    var up=st[st.length-1];
    if((++go&63)===0&&Date.now()>until){R.over=true;return false}
    if(x.nodeType===3){
      var l=up.x?0:x.nodeValue.trim().length;
      if(l){
        if(own)R.v+=up.w?"1":"0";
        if(!up.h){R.c+=l;if(up.b)R.b+=l;if(up.d)R.d+=l;if(!up.k)R.tx.push(x)}
      }
      st.push(up);
    }else{
      if(++N>MAX_ELEMENTS){R.over=true;return false}
      st.push(x.nodeType===1?enter(x,up,R):up);
    }
    return true;
  }
  for(;;){
    n=t.firstChild();
    if(!n){
      for(;;){
        st.pop();
        n=t.nextSibling();
        if(n)break;
        if(!t.parentNode())return R;
      }
    }
    if(!visit(n))return R;
  }
}
function fine(R){return!R.over&&!R.d&&!(R.c&&R.b/R.c>MAX_BAD)}
// Does text that turns light lie over something that keeps its paint: a kept band or a picture, moved there by a margin, a height of 0, anything? It would then be as hidden or as shown as that lets it be. Only if there are any such things, and within the budget.
function overlaps(O,X){
  if(!O.length||!X.length)return false;
  var B={},i,j,y,a,b,r,L,g=rng(),e,top,end,m,n=0;
  function late(){return(++n&1023)===0&&Date.now()>until}
  for(i=0;i<O.length;i++){
    // By its boxes: a highlight wrapped over lines is no block over all of them.
    L=O[i].getClientRects();
    for(m=0;m<L.length;m++){
      r=L[m];
      if(r.width<4||r.height<4)continue;
      for(y=Math.floor(r.top/CELL),end=Math.floor(r.bottom/CELL);y<=end;y++){(B[y]=B[y]||[]).push(i,r);if(late())return true}
    }
    if(Date.now()>until)return true;
  }
  for(i=0;i<X.length;i++){
    if((i&15)===0&&Date.now()>until)return true;
    g.selectNodeContents(X[i]);
    L=g.getClientRects();
    for(j=0;j<L.length;j++){
      a=L[j];
      for(y=Math.floor(a.top/CELL),end=Math.floor(a.bottom/CELL);y<=end;y++){
        e=B[y];
        for(var k=0;e&&k<e.length;k+=2){
          if(late())return true;
          b=e[k+1];
          top=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
          if(top>Math.max(3,a.height*0.3)&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>3&&!O[e[k]].contains(X[i]))return true;
        }
      }
    }
  }
  return false;
}
function restore(){gen++;queue=[];for(var i=undo.length-2;i>=0;i-=2)undo[i].cssText=undo[i+1];undo=[]}
function apply(W){var i,st,last;try{for(i=0;i<W.length;i+=3){st=W[i].style;if(st!==last){undo.push(st,st.cssText);last=st}st.setProperty(W[i+1],W[i+2],"important")}}catch(x){restore();throw x}}
function plate(e,c){try{var st=e.style;st.setProperty("background-color",c,"important");st.setProperty("border-radius","3px","important")}catch(x){}}
// A transparent dark picture on the pane: only such a one wants what it sat on behind it.
function darkAndClear(p){
  if(p.naturalWidth*p.naturalHeight>MAX_READ_PIXELS)return true;
  var e=mk("canvas"),x;e.width=e.height=SIDE;x=e.getContext("2d",{willReadFrequently:true});x.drawImage(p,0,0,SIDE,SIDE);
  var D=x.getImageData(0,0,SIDE,SIDE).data,clear=0,n=0,sum=0;
  for(var i=0;i<D.length;i+=4){if(D[i+3]<40)clear++;else{n++;sum+=lum([D[i],D[i+1],D[i+2]])}}
  return clear>SIDE*SIDE*0.02&&n>0&&sum/n<=0.3;
}
var reads=0,gen=0,known=new Map(),queue=[],pumping=false;
// Its pixels are readable from a second copy asked for by CORS, of the very address in the email. The sender's server sees that second request, with Origin: null, and can tell the mail was opened dark here: a known price of not losing a logo, and only for what passes the size and the count.
function ask(e,c,s){
  var a=new Pic(),t,done=false,g=gen;
  function end(say){if(done)return;done=true;clearTimeout(t);a.onload=a.onerror=null;known.set(e,say);if(say&&g===gen)plate(e,c)}
  a.crossOrigin="anonymous";
  a.onload=function(){var say=true;try{say=darkAndClear(a)}catch(x){}end(say)};
  a.onerror=function(){end(true)};
  t=setTimeout(function(){end(true)},READ_MS);
  a.src=s;
}
// True if it wants its plate now. Nothing waits for one, and a plate moves no layout.
function wants(e,c,r){
  if(r<0||r>MAX_PLATE_WIDTH)return false;
  if(known.has(e))return known.get(e);
  if(r<=1||reads>=MAX_READS)return true;
  reads++;
  if(e.naturalWidth*e.naturalHeight>MAX_READ_PIXELS)return true;
  var s=e.currentSrc||e.src;
  if(s.slice(0,5)==="data:"){try{return darkAndClear(e)}catch(x){return true}}
  ask(e,c,s);
  return false;
}
// A slice at a time, and each rect read before any write: a hostile email has thousands of pictures, or large ones.
function pump(){
  pumping=false;
  var t=Date.now()+SLICE_MS,b=queue.splice(0,128),r=[],put=[],i;
  for(i=0;i<b.length;i+=2)r.push(b[i].naturalWidth?b[i].getBoundingClientRect().width:-1);
  for(i=0;i<b.length;i+=2){
    if(wants(b[i],b[i+1],r[i/2]))put.push(b[i],b[i+1]);
    if(Date.now()>t){queue=b.slice(i+2).concat(queue);break}
  }
  for(i=0;i<put.length;i+=2)plate(put[i],put[i+1]);
  if(queue.length)soon();
}
function soon(){if(!pumping){pumping=true;setTimeout(pump,0)}}
function plates(P){
  var g=gen;
  for(var i=0;i<P.length;i+=2)(function(e,c){
    if(e.complete)queue.push(e,c);
    else e.addEventListener("load",function(){if(g===gen){queue.push(e,c);soon()}},{once:true});
  })(P[i],P[i+1]);
  soon();
}
function measure(base){var hs=gcs(h),bg=parse(hs.backgroundColor),im=hs.backgroundImage!=="none",mine=!!bg&&bg[3]>0&&lum(bg)<0.97,cv=mine?blend(bg,WHITE):base,R=walk({o:cv,n:cv,k:true,u:im,pl:false,g:false,h:false,b:false,d:false,w:false,x:false},true);R.paint=!mine&&!im;return R}
// The sender's own dark version, if that can read and says the same words as the light one.
function own(){
  if(!(q&&q.matches&&hasOwnDark())||widths.length||tooWide||!paintOnly())return false;
  var A=measure(SURFACE);
  if(!fine(A))return false;
  settle(false);
  var B=measure(WHITE);
  if(B.over||A.v!==B.v)return false;
  settle(true);
  // White on the root is the frame's own: nothing paints the canvas until this does.
  if(A.paint){set(h,"background-color",css(SURFACE));set(h,"color-scheme","dark")}
  return true;
}
function flip(){
  var R=walk({o:WHITE,n:SURFACE,k:false,u:false,pl:false,g:false,h:false,b:false,d:false,w:false,x:false},false);
  if(!fine(R)||overlaps(R.ob,R.tx))return"paper";
  // Light on dark reads heavier unless told otherwise.
  if(!R.root.k)R.w.push(h,"background-color",css(SURFACE),h,"color-scheme","dark",h,"-webkit-font-smoothing","antialiased");
  apply(R.w);
  try{plates(R.p)}catch(x){}
  return"dark";
}
function sign(){var s="";for(var i=0;i<marks.length;i++)s+=marks[i].matches?"1":"0";return s}
// Inline colours were read at one width, and a rule of the email's for another width would lose to them or set a background under them: past one, it is read again.
function follow(){
  if(!mm||!widths.length)return;
  marks=widths.map(function(t){return mm(t)});
  var was=sign(),t=0,said="dark",changes=0;
  function moved(){clearTimeout(t);t=setTimeout(function(){
    var now=sign(),L;
    if(now===was)return;
    was=now;
    try{restore();until=Date.now()+flipBudgetMs;L=flip()}catch(x){restore();L="paper"}
    // An email that keeps changing its mind with the width flashes: after two changes it stays on paper, and this listens no more.
    if(L!==said&&++changes>=MAX_CHANGES){if(L!=="paper"){restore();L="paper"}w.removeEventListener("resize",moved)}
    if(L!==said){said=L;send({type:"look",look:L})}
    later();
  },RE_DRESS_MS)}
  w.addEventListener("resize",moved);
}
// What this frame shows, before it is measured. Nothing to say without the flag: the light version, as it ever was.
function dress(){
  if(!D){try{if(q&&q.matches)calm();else if(q&&q.addEventListener)q.addEventListener("change",calm)}catch(x){}return null}
  var L;
  try{
    until=Date.now()+flipBudgetMs;
    scan();
    if(own())return"own";
    calm();
    // Too many widths to follow.
    L=tooWide?"paper":flip();
  }catch(x){try{restore()}catch(y){}try{calm()}catch(y){}return"paper"}
  if(L==="dark")try{follow()}catch(x){}
  return L;
}
`;
