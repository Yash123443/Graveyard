// @ts-nocheck
/**
 * THE ANALYST — procedural 3D spectral character (Three.js). No model files, no textures.
 * Hooded witch-like figure: shadowed void, glowing eyes, jointed hands, bare feet,
 * tattered robe, glowing veins, trailing ribbons, rising wisps and gathering particles.
 *
 *   const analyst = createAnalyst(parent, { pos:[x,y,z], rotY:1, scale:1, color:[.55,.15,1], skipIntro:false });
 *   analyst.update(dt)            // free-running   |   analyst.set(T, t, pose) // drive it from your own timeline
 *   analyst.replay(); analyst.setPose(0|1); analyst.setPixelRatio(r); analyst.dispose();
 * Entrance plays over T = 0..11 s (particles gather 2.5-7.5, body materializes 6.5-11, arm reaches ~10.5).
 */
import * as THREE from 'three'

export function createAnalyst(parent: any, o: any = {}) {
 const sm=x=>x<0?0:x>1?1:x*x*(3-2*x),cl=x=>Math.max(0,Math.min(1,x)),ss=(a,b,x)=>sm((x-a)/(b-a));
 const GT=(()=>{const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d'),g=x.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,'#fff');g.addColorStop(.25,'rgba(255,255,255,.35)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,128,128);return new THREE.CanvasTexture(c)})();
function sculptFace(){const g=new THREE.SphereGeometry(1,110,80),p=g.attributes.position,ao=new Float32Array(p.count);
 const E=(x,y,cx,cy,sx,sy)=>Math.exp(-((x-cx)**2/(sx*sx)+(y-cy)**2/(sy*sy)));
 for(let i=0;i<p.count;i++){let x=p.getX(i),y=p.getY(i),z=p.getZ(i);const ax=Math.abs(x);let d=0;
  d-=.15*E(ax,y,.37,.14,.17,.1);d+=.13*E(ax,y,.34,.3,.27,.055);d+=.045*E(ax,y,.36,-.02,.15,.04);d+=.05*E(ax,y,.6,-.12,.17,.14);d-=.04*E(ax,y,.3,-.38,.04,.2);
  d+=.2*E(x,y,0,-.06,.08,.22);d+=.17*E(x,y,0,-.3,.12,.07);d+=.05*E(ax,y,.14,-.34,.06,.05);
  d-=.1*E(x,y,0,-.55,.24,.022);d+=.035*E(x,y,0,-.49,.16,.03);d+=.045*E(x,y,0,-.62,.15,.04);d+=.11*E(x,y,0,-.9,.12,.11);
  d-=.014*Math.pow(Math.max(0,Math.sin(y*30+Math.sin(x*4)*1.2)),2)*E(x,y,0,.64,.7,.2);
  d*=z>0?Math.pow(z,.6):0;x*=1-.38*ss(0,-.9,y);y*=1.08;ao[i]=cl(-d*5);
  p.setXYZ(i,x*(1+d),y*(1+d),z*(1+d))}
 g.setAttribute('aAO',new THREE.BufferAttribute(ao,1));g.computeVertexNormals();return g}

 const VR={analyst:{col:[.55,.15,1],shape:[1,1,1],vw:.018,base:[.012,.007,.03],skin:[.11,.08,.1],sk2:[.7,.5,.8],scale:1},
  fixer:{col:[1,.2,.1],shape:[1.08,1.16,1.02],vw:.026,base:[.03,.008,.006],skin:[.17,.07,.05],sk2:[.9,.5,.45],scale:1.04},
  tester:{col:[.15,1,.55],shape:[.96,1.04,.96],vw:.015,base:[.01,.03,.02],skin:[.42,.52,.47],sk2:[.5,.85,.7],scale:1.02}};
 const kind=o.variant||'analyst',V=VR[kind],col=o.color||V.col,pos=o.pos||[0,0,0],rotY=o.rotY??1,S=(o.scale??1)*V.scale;
 const U={uTime:{value:0},uAppear:{value:0},uCol:{value:new THREE.Vector3(...col)},uShape:{value:new THREE.Vector3(...V.shape)}};
 const vs=`uniform float uTime,uMode;uniform vec3 uShape;varying vec3 vN,vV,vP;varying float vT,vA,vWY;
 float pr(float t){float r=mix(.64*uShape.z,.31,smoothstep(0.,.45,t));r=mix(r,.21,smoothstep(.45,.7,t));r=mix(r,.25,smoothstep(.7,.88,t));return mix(r,.1,smoothstep(.88,1.,t));}
 void main(){vec3 p=position,n=normal;vT=uv.y;vA=atan(position.z,position.x);
 if(uMode>1.5){vec3 u=position/.23;float lw=smoothstep(.1,-1.,u.y);p.y-=lw*.03;p.xz*=1.+lw*.06;float bk=max(0.,-u.z);p.z-=bk*bk*.16*(.5+u.y*.5);p.y-=bk*bk*.05;}
 else if(uMode>.5){float t=clamp(position.y/1.3+.5,0.,1.),a=vA,w=pow(1.-t,1.5),r=pr(t);
  float ph=a*9.+sin(a*3.)*1.5+t*3.,f=sin(ph)*.035*(.3+w)+sin(a*17.-t*2.)*.012;
  float df=cos(ph)*(9.+4.5*cos(a*3.))*.035*(.3+w)+cos(a*17.-t*2.)*.204;
  float sc=1.+f/.3;sc*=1.+.07*sin(a*5.+t*7.-uTime*1.6)*w;sc*=1.+.3*w*max(0.,-sin(a));
  float rx=r*(1.+.4*uShape.y*smoothstep(.6,.92,t))*sc*uShape.x,rz=r*.82*sc*uShape.x;
  p=vec3(cos(a)*rx,.02+t*1.68,sin(a)*rz);p.z-=w*(.24+.1*sin(uTime*.9+a));p.x+=sin(uTime*1.1+t*4.)*.06*w;
  n=normalize(vec3(cos(a)/rx,0.,sin(a)/rz));n=normalize(n-vec3(-sin(a),0.,cos(a))*df*1.2+vec3(0.,.25,0.));vT=t;}
 vP=p;vN=normalize(normalMatrix*n);vec4 mv=modelViewMatrix*vec4(p,1.);vV=normalize(-mv.xyz);vWY=(modelMatrix*vec4(p,1.)).y;gl_Position=projectionMatrix*mv;}`;
 const fs=`uniform float uTime,uAppear,uRag,uHood,uVein,uVW;uniform vec3 uCol,uBase;varying vec3 vN,vV,vP;varying float vT,vA,vWY;
 float h(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
 float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
 void main(){float d=n3(vP*5.)*.55+(1.-clamp((vWY-.3)/2.4,0.,1.))*.45;if(d>uAppear)discard;
  float ed=smoothstep(uAppear-.07,uAppear,d),rag=0.,re=0.,rim=0.,dk=1.;
  if(uHood>.5){vec3 u=vP/.23;float op=u.x*u.x/.38+(u.y-.03)*(u.y-.03)/.55;if(u.z>.05&&op<1.)discard;rim=smoothstep(1.3,1.,op)*step(.05,u.z);dk=gl_FrontFacing?1.:.18;}
  if(uRag>.5){rag=(sin(vA*9.+1.)*.5+.5)*(sin(vA*17.+2.)*.5+.5)*.17+n3(vec3(vA*6.,vT*2.,uTime*.3))*.07;if(vT<rag)discard;re=smoothstep(.04,0.,vT-rag);}
  vec3 N=normalize(vN),V=normalize(vV);float f=pow(1.-abs(dot(N,V)),2.),f2=pow(1.-abs(dot(N,V)),5.);
  float df=clamp(dot(N,normalize(vec3(.55,.35,.75))),0.,1.)*.5+clamp(dot(N,normalize(vec3(-.6,.2,-.5))),0.,1.)*.25;
  float vn=n3(vP*3.6+vec3(0.,uTime*.15,0.))*.65+n3(vP*8.)*.35;
  float vein=1.-smoothstep(0.,uVW,abs(vn-.5));vein*=(.3+.7*(.5+.5*sin(vP.y*8.-uTime*2.4+vn*7.)))*uVein;
  float core=exp(-pow((vP.y-1.15)*3.5,2.))*.4*(1.-f);
  vec3 c=(uBase+uCol*(df*.22+(f*.5+f2*1.0)*(1.-.65*uHood)+vein*1.5+core))*dk+vec3(.9,.7,1.)*(ed*2.+re*.6+vein*vein*.2)+uCol*rim*.35;
  float al=.82+f*.18+vein*.2+ed;if(uRag>.5)al*=smoothstep(rag,rag+.12,vT);gl_FragColor=vec4(c,clamp(al,0.,1.));}`;
 const mk=(m,r,hd,vn)=>new THREE.ShaderMaterial({uniforms:{...U,uMode:{value:m},uRag:{value:r},uHood:{value:hd},uVein:{value:vn},uVW:{value:V.vw},uBase:{value:new THREE.Vector3(...V.base)}},vertexShader:vs,fragmentShader:fs,transparent:true,depthWrite:false,side:THREE.DoubleSide});
 const body=mk(1,1,0,1),gen=mk(0,0,0,1),slv=mk(0,1,0,.6),hoodM=mk(2,0,1,.12),skn=mk(0,0,0,.18);
 skn.uniforms.uBase.value.set(...V.skin);skn.uniforms.uCol={value:new THREE.Vector3(...V.sk2)};
 const root=new THREE.Group();root.position.set(pos[0],pos[1],pos[2]);root.scale.setScalar(S);parent.add(root);const G=new THREE.Group();root.add(G);const glow=new THREE.PointLight(new THREE.Color(...col),0,o.lightDistance??5,2);glow.position.set(0,1.8,.9);G.add(glow);
 const cyl=(a,b,l,s=16,hs=1,open=false,m=gen)=>{const g=new THREE.CylinderGeometry(a,b,l,s,hs,open);g.translate(0,-l/2,0);return new THREE.Mesh(g,m)};
 G.add(new THREE.Mesh(new THREE.CylinderGeometry(1,1,1.3,128,60,true),body));
 if(kind!=='tester'){const mant=new THREE.Mesh(new THREE.CylinderGeometry(.14,kind==='fixer'?.55:.36,.24,64,12,true),slv);mant.scale.set(1.08,1,.8);mant.position.y=1.58;G.add(mant)}
 if(kind==='fixer')[-1,1].forEach(s=>{const p=new THREE.Mesh(new THREE.SphereGeometry(1,28,18),gen);p.scale.set(.21,.13,.2);p.position.set(s*.5,1.58,0);p.rotation.z=-s*.4;G.add(p)});
 // A deliberately oversized hood and an unreadable void give the figures a threatening,
 // human-scale silhouette instead of exposing a small, doll-like face.
 const head=new THREE.Group();head.position.set(0,1.8,0);head.rotation.x=.14;G.add(head);
 const hood=new THREE.Mesh(new THREE.SphereGeometry(.38,56,40),hoodM);const hs=kind==='fixer'?1.12:1;hood.scale.set(hs,1.22*hs,1.15*hs);head.add(hood);
 
 const vd=new THREE.Mesh(new THREE.SphereGeometry(.32,32,20),new THREE.MeshBasicMaterial({color:0x000001,transparent:true,opacity:0}));vd.scale.set(.86,1.12,.7);vd.position.z=.04;vd.renderOrder=-1;vd.visible=true;head.add(vd);
 const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:GT,color:new THREE.Color(...col),blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));halo.scale.set(1.5,1.5,1);halo.position.z=-.2;head.add(halo);
 const fx=new THREE.Group();head.add(fx);
 if(kind==='analyst'&&o.showHumanFace){const face=new THREE.Mesh(sculptFace(),new THREE.ShaderMaterial({uniforms:{uA:U.uAppear,uC:U.uCol},
  vertexShader:`attribute float aAO;varying vec3 vN,vP,vV;varying float vAO;void main(){vP=position;vAO=aAO;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform float uA;uniform vec3 uC;varying vec3 vN,vP,vV;varying float vAO;void main(){if(uA<.65)discard;vec3 N=normalize(vN);
   float d=clamp(dot(N,normalize(vec3(.3,.35,.9))),0.,1.),f=pow(1.-abs(dot(N,normalize(vV))),2.),ax=abs(vP.x);
   float sh=(1.-smoothstep(-.3,.9,vP.y)*.8)*(1.-smoothstep(.45,.95,ax)*.7);
   vec3 sk=mix(vec3(.62,.6,.5),uC,.1);
   float brow=smoothstep(.05,.0,abs(vP.y-(.36+(ax-.1)*.1)))*step(.12,ax)*step(ax,.62);
   float lip=smoothstep(.07,.0,abs(vP.y+.57))*step(ax,.24);
   sk=mix(sk,vec3(.1,.09,.09),brow*.85);sk=mix(sk,vec3(.34,.2,.28),lip*.8);
   sk*=1.-smoothstep(.12,0.,abs(vP.y-.05))*step(.2,ax)*step(ax,.55)*.35;
   float lo=1.-smoothstep(-.4,-1.,vP.y)*.5;
   vec3 c=sk*(.06+.7*d)*sh*lo*(1.-vAO*.6)+uC*f*.5*(.4+.6*sh)+uC*.03;
   gl_FragColor=vec4(c*smoothstep(.65,.95,uA),1.);}`}));
 face.scale.set(.105,.14,.12);face.position.set(0,-.02,.04);fx.add(face);
 const nk=cyl(.055,.07,.2,14,1,false,skn);nk.position.set(0,-.12,0);fx.add(nk);}
 const eyeC=new THREE.Color(col[0],col[1],col[2]),eyeM=new THREE.MeshBasicMaterial({color:eyeC.clone().lerp(new THREE.Color(1,1,1),.7),transparent:true,opacity:0}),eyes=[],glows=[],rings=[];let scan=null,scanG=null,fcore=null;
 const addEye=(x,y,z,sx,sy,rz,gx,gy,gz)=>{const e=new THREE.Mesh(new THREE.SphereGeometry(.016,12,8),eyeM);e.scale.set(sx,sy,.5);e.userData.sy=sy;e.position.set(x,y,z);e.rotation.z=rz;fx.add(e);eyes.push(e);
  const g=new THREE.Sprite(new THREE.SpriteMaterial({map:GT,color:eyeC,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));g.scale.set(gx,gy,1);g.userData.sy=gy;g.position.set(x,y,gz);fx.add(g);glows.push(g)};
 if(kind==='analyst')[-1,1].forEach(s=>addEye(s*.055,-.01,.27,1.15,.24,-s*.1,.09,.035,.29));
 if(kind==='fixer'){[-1,1].forEach(s=>addEye(s*.085,.015,.255,1.65,.18,s*.28,.14,.035,.275));
  fcore=new THREE.Sprite(new THREE.SpriteMaterial({map:GT,color:eyeC,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));fcore.scale.set(.9,1.1,1);fcore.position.set(0,1.2,.22);G.add(fcore)}
 if(kind==='tester')[-1,1].forEach(s=>addEye(s*.055,-.01,.27,1.15,.24,-s*.1,.09,.035,.29));
 if(kind==='analyst'||kind==='fixer'){
  [-1,1].forEach((s,i)=>{const m=new THREE.Mesh(new THREE.TorusGeometry(.48+i*.13,.008,6,72),new THREE.MeshBasicMaterial({color:eyeC,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}));m.position.set(0,.62+i*.38,0);m.rotation.x=Math.PI/2;m.userData.sp=[s*(.32+i*.12),s*(.48+i*.16)];G.add(m);rings.push(m)})
 }
 // This collection is intentionally built once: step() runs every rendered frame.
 const eyesAndGlows=[...eyes,...glows];
 // legs: smooth lathe leg + shaped bare foot
 const LP=[[.001,0],[.062,0],[.064,-.1],[.05,-.24],[.054,-.34],[.046,-.47],[.03,-.6],[.027,-.66],[.001,-.67]].map(a=>new THREE.Vector2(a[0],a[1]));
 const legs=[-1,1].map(s=>{const l=new THREE.Group();l.position.set(s*.1,.9,0);l.add(new THREE.Mesh(new THREE.LatheGeometry(LP,18),skn));
  const ft=new THREE.Group();ft.position.y=-.64;ft.rotation.x=.4;
  const fo=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),skn);fo.scale.set(.032,.09,.046);fo.position.set(0,-.07,.016);ft.add(fo);
  const hl=new THREE.Mesh(new THREE.SphereGeometry(.03,10,8),skn);hl.position.set(0,-.01,-.012);ft.add(hl);
  [[-.024,.016],[-.012,.014],[0,.013],[.012,.0125],[.024,.011]].forEach(([x,r],i)=>{const t=new THREE.Mesh(new THREE.SphereGeometry(r,8,6),skn);t.scale.set(1,1.4,1);t.position.set(x*s*-1,-.158+Math.abs(x)*.3,.042);ft.add(t)});
  l.add(ft);G.add(l);return l});legs.forEach(l=>l.visible=kind==='analyst');
 // arms
 const aw=kind==='fixer'?1.5:kind==='tester'?.75:1,fw=kind==='fixer'?1.35:kind==='tester'?.6:1;
 function arm(s){const S=new THREE.Group();S.position.set(s*(kind==='fixer'?.4:kind==='tester'?.26:.32),1.5,0);S.add(cyl(.058*aw,.072*aw,.4,20,6));
  const E=new THREE.Group();E.position.y=-.4;S.add(E);E.add(cyl(.064*aw,.14*fw,.44,28,10,true,slv));
  const W=new THREE.Group();W.position.y=-.43;W.scale.setScalar(kind==='fixer'?1.35:kind==='tester'?1.15:1);E.add(W);const pm=new THREE.Mesh(new THREE.BoxGeometry(.07,.09,.024),skn);pm.position.y=-.05;W.add(pm);
  const fg=[];[[-.027,.05],[-.009,.06],[.009,.056],[.027,.046],[.043,.045]].forEach(([x,L],i)=>{const a=new THREE.Group(),th=i==4;a.position.set(x,th?-.03:-.1,0);if(th)a.rotation.z=-.7;
   a.add(cyl(.011,.0085,L,6,1,false,skn));const b=new THREE.Group();b.position.y=-L;a.add(b);b.add(cyl(.0085,.005,L*.85,6,1,false,skn));W.add(a);fg.push([a,b])});
  G.add(S);return {S,E,W,fg}}
 const aS=arm(-1),aI=arm(1);
 const tv=`uniform float uTime,uSeed;varying vec2 vUv;void main(){vUv=uv;vec3 p=position;float v=1.-uv.y;p.z-=v*1.1+sin(uv.y*7.-uTime*1.8+uSeed)*.15*v;p.x+=sin(uv.y*5.-uTime*1.3+uSeed*2.)*.2*v;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`;
 const tf=`uniform float uAppear;uniform vec3 uCol;varying vec2 vUv;void main(){float v=1.-vUv.y;float a=pow(1.-v,1.7)*smoothstep(0.,.35,vUv.x)*smoothstep(1.,.65,vUv.x)*.3*clamp((uAppear-.5)*2.,0.,1.);gl_FragColor=vec4(uCol*(1.1+(1.-v)),a);}`;
 const NW=kind==='fixer'?1300:800,ws=new Float32Array(NW*4).map(Math.random),wg=new THREE.BufferGeometry();wg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(NW*3),3));wg.setAttribute('aS',new THREE.BufferAttribute(ws,4));
 const WU={uCol:U.uCol,uTime:U.uTime,uAppear:U.uAppear,uPx:{value:Math.min(window.devicePixelRatio||1,2)}};
 const wp=new THREE.Points(wg,new THREE.ShaderMaterial({uniforms:WU,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  vertexShader:`uniform float uTime,uPx,uAppear;attribute vec4 aS;varying float vA;void main(){float ag=fract(uTime*(.1+aS.w*.12)+aS.x),a=aS.y*6.283,y=.45+aS.z*1.3;
   vec3 p=vec3(cos(a)*.34,y,sin(a)*.26)+vec3(sin(ag*6.+aS.x*20.)*.12,ag*.9,-ag*.7-ag*ag*.5);vec4 mv=modelViewMatrix*vec4(p,1.);
   gl_PointSize=(.8+aS.z*2.4)*uPx*(6./-mv.z);vA=sin(ag*3.14159)*clamp((uAppear-.6)*3.,0.,1.);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform vec3 uCol;varying float vA;void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,0.,d);gl_FragColor=vec4(mix(uCol*1.15,vec3(1.),smoothstep(.15,0.,d)),a*a*vA);}`}));
 wp.frustumCulled=false;G.add(wp);
 const N=1400,sd=new Float32Array(N*4).map(Math.random),pg=new THREE.BufferGeometry();pg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(N*3),3));pg.setAttribute('aSeed',new THREE.BufferAttribute(sd,4));
 const PU={uCol:U.uCol,uTime:U.uTime,uEm:{value:0},uGa:{value:0},uPx:WU.uPx,uC:{value:new THREE.Vector3(0,.8,0)}};
 const gp=new THREE.Points(pg,new THREE.ShaderMaterial({uniforms:PU,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  vertexShader:`uniform float uTime,uEm,uGa,uPx;uniform vec3 uC;attribute vec4 aSeed;varying float vA;void main(){
   vec3 fg=uC+vec3((aSeed.x-.5)*30.,aSeed.y*4.5-1.2,(aSeed.z-.5)*18.-2.)+vec3(sin(uTime*.3+aSeed.w*30.),sin(uTime*.4+aSeed.x*20.)*.4,cos(uTime*.25+aSeed.y*25.))*.8;
   float an=uTime*(.25+aSeed.w*.5)+aSeed.z*6.28,rd=.4+aSeed.x*1.1;vec3 ob=uC+vec3(cos(an)*rd,(aSeed.y-.4)*2.6,sin(an)*rd*.8);
   float g=smoothstep(aSeed.w*.45,aSeed.w*.45+.55,uGa);vec3 p=mix(fg,ob,g);p.y+=sin(g*3.14159)*1.4*(aSeed.x-.5);
   vec4 mv=modelViewMatrix*vec4(p,1.);float tw=.6+.4*sin(uTime*3.+aSeed.w*50.);gl_PointSize=(1.6+aSeed.z*4.)*uPx*(7./-mv.z)*tw;
   vA=smoothstep(aSeed.x*.7,aSeed.x*.7+.3,uEm)*(.3+.6*tw);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform vec3 uCol;varying float vA;void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,0.,d);gl_FragColor=vec4(mix(uCol*1.15,vec3(1.,.9,1.),smoothstep(.16,0.,d)),a*a*vA);}`}));
 gp.frustumCulled=false;root.add(gp);
 let pose=0;
 const step=(T,t,target,fade=1)=>{
  U.uTime.value=t;const A=U.uAppear.value=sm((T-6.5)/4.5)*1.1*fade;PU.uEm.value=sm(T/3)*fade;PU.uGa.value=sm((T-2.5)/5);
  pose+=(target-pose)*.04;const bob=Math.sin(t*1.2)*.09;
  G.position.set(0,bob,0);G.rotation.set(.06,rotY+Math.sin(t*.5)*.05,Math.sin(t*.7)*.015);
  vd.material.opacity=cl((A-.6)*3);fx.visible=A>.65;{const ea=cl((A-.75)*3.5)*(.8+.2*pose+.1*Math.sin(t*2.3)),kb=t%4.3,bl=kb<.16?Math.abs(kb-.08)/.08:1;eyeM.opacity=ea;eyesAndGlows.forEach(m=>m.scale.y=m.userData.sy*(.12+.88*bl));glows.forEach(g=>g.material.opacity=ea*.85);rings.forEach((r,i)=>{r.material.opacity=ea*(i<2?.55:.4);if(r.userData.sp){r.rotation.x=t*r.userData.sp[0]+1.1;r.rotation.y=t*r.userData.sp[1]}});if(scan){scan.position.x=Math.sin(t*1.5)*.065;scanG.position.x=scan.position.x}if(fcore)fcore.material.opacity=cl((A-.6)*2)*(.5+.25*Math.sin(t*3))}
  halo.material.opacity=cl((A-.5)*1.2)*.3;head.rotation.y=Math.sin(t*.4)*.12+pose*.1;
  legs.forEach((l,i)=>{l.rotation.x=Math.sin(t*1.1+i*1.3)*.05;l.rotation.z=(i?1:-1)*.03});
  const f=(a,k)=>{a.S.rotation.set(k.s,0,k.z);a.E.rotation.x=k.e;a.W.rotation.x=k.w;a.fg.forEach(([x,y],i)=>{x.rotation.x=-k.c;y.rotation.x=-k.c*1.2;if(i<4)x.rotation.z=(i-1.5)*k.sp})};
  if(kind==='analyst'){f(aS,{s:-.12-1.1*pose+Math.sin(t*1.3)*.03,z:.12-.1*pose,e:-.25-.4*pose,w:-.15*pose,c:.55-.35*pose+Math.sin(t*2)*.04*pose,sp:.1*pose});
   f(aI,{s:.1+Math.sin(t*.9)*.04,z:-.1,e:-.3,w:0,c:.6,sp:0})}
  else if(kind==='fixer'){const w=Math.sin(t*3)*.04;f(aS,{s:-.15-.95*pose+w,z:.05+.1*pose,e:-.3-.7*pose,w:-.2*pose,c:.7-.45*pose,sp:.05});f(aI,{s:-.15-.95*pose-w,z:-.05-.1*pose,e:-.3-.7*pose,w:-.2*pose,c:.7-.45*pose,sp:.05})}
  else{const q=Math.sin(t*1.2)*.04;f(aS,{s:-.25*pose,z:-(.35+.75*pose)+q,e:-.2-.2*pose,w:0,c:.15,sp:.18*pose+.08});f(aI,{s:-.25*pose,z:(.35+.75*pose)-q,e:-.2-.2*pose,w:0,c:.15,sp:.18*pose+.08})}
  const L=sm((T-7.5)/4);glow.intensity=L*A*(o.lightIntensity??1.2);return L};
 let T=o.skipIntro?20:0,t=0,target=0,auto=true;
 return {
  group:root,
  /** advance by dt seconds (free-running timeline) */
  update(dt){T+=dt;t+=dt;return step(T,t,auto?(T>10.5?1:0):target)},
  /** drive the timeline yourself: T = intro seconds (0..11 plays the entrance), t = absolute seconds, pose 0|1 */
  set(Tn,tn,pose=1,fade=1){T=Tn;t=tn;return step(T,t,pose,fade)},
  replay(){T=0;auto=true},setPose(v){auto=false;target=v},
  setPixelRatio(v){WU.uPx.value=v},
  dispose(){root.traverse(n=>{n.geometry&&n.geometry.dispose();const m=n.material;m&&(Array.isArray(m)?m:[m]).forEach(x=>x.dispose())});GT.dispose();parent.remove(root)}
 };

}
