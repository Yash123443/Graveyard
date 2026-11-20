import { soulSpellOrigins } from '../animations/soulSpellOrigins'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seq } from '../animations/sequence'
import { ritualPower } from '../animations/ritualPower'
import { createFogTexture, createGlowTexture } from '../utils/proceduralTextures'

const colors=['#46778e','#a45832','#754888']
const origins=[[-4,2.29,3.42],[1.95,2.22,3.25],[-1.06,6.71,-.72]]
// Broad turbulent smoke travels from the animated held prop; no hard beams.
const vertexShader=`
 attribute float seed;
 uniform float time,power,pointScale,pixelRatio;
 uniform vec3 origin;
 varying float alpha;
 varying float phase;
 void main(){
  float n=fract(seed*.6180339);
  float delay=fract(seed*.317)*1.3;
  float age=max(0.0,time-delay);
  float life=fract(age*(.24+n*.08));
  float a=seed*2.39996+time*(.45+n*.6);
  float spread=.35+fract(seed*.713)*1.1;
  vec3 p;
  if(n<.25){
   float r=(.08+life*.28)*spread;
   p=origin+vec3(cos(a)*r,sin(a*1.37)*r*.7+life*.2,sin(a)*r);
  }else{
   float travel=smoothstep(.05,.94,life);
   vec3 destination=vec3(0.0,.7,1.25);
   p=mix(origin,destination,travel);
   // Smoke expands after leaving the hand, curls, then disperses over the soil.
   float billow=sin(travel*3.14159)*(.45+spread*.65);
   p+=vec3(cos(a+travel*5.0),sin(a*1.31+travel*4.0)*.65,sin(a+travel*5.0))*billow;
   p.y+=sin(travel*3.14159)*.55;
  }
  vec4 view=modelViewMatrix*vec4(p,1.0);
  gl_Position=projectionMatrix*view;
  gl_PointSize=min(110.0,pointScale*pixelRatio*(.65+n*.5)/max(1.0,-view.z));
  alpha=power*smoothstep(delay,delay+.15,time)*smoothstep(0.0,.15,life)*(1.0-smoothstep(.65,1.0,life));
  phase=seed+time*.3;
 }
`
const fragmentShader=`
 uniform vec3 color;
 uniform float mist;
 uniform sampler2D cloud;
 varying float alpha;
 varying float phase;
 void main(){
  vec2 uv=gl_PointCoord;
  float radius=length(uv-.5)*2.0;
  float edge=1.0-smoothstep(.35,1.0,radius);
  float haze=texture2D(cloud,uv).a;
  float ember=exp(-radius*radius*12.0);
  float opacity=mix(ember,haze*edge,mist)*alpha;
  gl_FragColor=vec4(color,opacity);
 }
`
function Spell({index}:{index:number}){
 const root=useRef<THREE.Group>(null)
 const charge=useRef<THREE.Sprite>(null)
 const burst=useRef<THREE.Sprite>(null)
 const time=useRef(0)
 const resources=useMemo(()=>{
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(180*3),3))
  geometry.setAttribute('seed',new THREE.Float32BufferAttribute(Array.from({length:180},(_,i)=>i+index*193),1))
  const cloud=createFogTexture(90+index,64),glow=createGlowTexture(64)
  const make=(mist:boolean)=>new THREE.ShaderMaterial({
   uniforms:{time:{value:0},power:{value:0},pointScale:{value:mist?650:26},pixelRatio:{value:1},origin:{value:new THREE.Vector3(...origins[index])},color:{value:new THREE.Color(colors[index])},mist:{value:mist?1:0},cloud:{value:cloud}},
   vertexShader,fragmentShader,transparent:true,depthWrite:false,blending:mist?THREE.NormalBlending:THREE.AdditiveBlending,toneMapped:false,
  })
  return {geometry,cloud,glow,haze:make(true),embers:make(false)}
 },[index])
 useEffect(()=>()=>{resources.geometry.dispose();resources.cloud.dispose();resources.glow.dispose();resources.haze.dispose();resources.embers.dispose()},[resources])
 useFrame(({gl},delta)=>{
  const power=ritualPower(index,seq.exploration.storyProgress,seq.ending.progress,seq.ending.outcome,seq.ending.started)
  if(root.current)root.current.visible=power>.002
  if(power<=.002){time.current=0;return}
  time.current+=Math.min(delta,.05)
  for(const material of [resources.haze,resources.embers]){
   material.uniforms.origin.value.copy(soulSpellOrigins[index]);material.uniforms.origin.value.z+=83
   material.uniforms.time.value=time.current
   material.uniforms.power.value=power*(material===resources.haze?.12:.5)
   material.uniforms.pixelRatio.value=gl.getPixelRatio()
  }
  if(charge.current){charge.current.position.copy(soulSpellOrigins[index]);charge.current.position.z+=83;charge.current.material.opacity=power*.22;charge.current.material.rotation=time.current*.3;charge.current.scale.setScalar(1.2+Math.sin(time.current*2.7)*.15)}
  if(burst.current){const pulse=.5+.5*Math.sin(time.current*2.1+index);burst.current.material.opacity=power*(.025+pulse*.035)*Math.min(1,Math.max(0,time.current-1.8));burst.current.scale.set(3+pulse,1.8+pulse*.6,1);burst.current.material.rotation=Math.sin(time.current*.5)*.2}
 })
 return <group ref={root} visible={false}>
  <points geometry={resources.geometry} material={resources.haze} frustumCulled={false}/>
  <points geometry={resources.geometry} material={resources.embers} frustumCulled={false}/>
  <sprite ref={charge} position={origins[index] as [number,number,number]}><spriteMaterial map={resources.glow} color={colors[index]} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}/></sprite>
  <sprite ref={burst} position={[0,1.1,1.25]}><spriteMaterial map={resources.cloud} color={colors[index]} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}/></sprite>
 </group>
}
/** Six GPU particle batches retain the existing performance and ritual timing. */
export function SoulMagic(){return <group position={[0,0,-83]}>{[0,1,2].map(index=><Spell key={index} index={index}/>)}</group>}
