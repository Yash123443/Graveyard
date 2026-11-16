import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { RoundedBox } from '@react-three/drei'
import { groundHeight } from './Ground'
import { WaxCandle } from './WaxCandle'
import { GraveInscription } from './GraveInscription'
import { createStoneTextures, createGroundTexture } from '../utils/proceduralTextures'
import { seq, smoothstep } from '../animations/sequence'
import { playMainGraveRumble } from '../audio/audioManager'

export const finalGraveSettings = { scale: 2.3, width: 1, length: 2, border: .12, crossHeight: 1.25, stoneColor: '#aaa28f', borderColor: '#c4b89d', leafAmount: 48, needleAmount: 140 }

/** A compact burial plot; repeated ground litter uses just two draw calls. */
export function FinalGravePlot() {
 const c=finalGraveSettings
 const needles=useRef<THREE.InstancedMesh>(null), leaves=useRef<THREE.InstancedMesh>(null)
 const lid=useRef<THREE.Group>(null), root=useRef<THREE.Group>(null)
 const armed=useRef(true)
 const textures=useMemo(()=>({stone:createStoneTextures(256),soil:createGroundTexture(256)}),[])
 const stone=useMemo(()=>new THREE.MeshStandardMaterial({color:c.stoneColor,map:textures.stone.map,bumpMap:textures.stone.bumpMap,bumpScale:.045,roughness:.96}),[textures,c.stoneColor])
 // Lighter limestone edging remains distinct in moonlight without extra lights.
 const borderStone=useMemo(()=>new THREE.MeshStandardMaterial({color:c.borderColor,bumpMap:textures.stone.bumpMap,bumpScale:.035,roughness:.9,emissive:'#8c8066',emissiveIntensity:.16}),[textures,c.borderColor])
 const plaqueStone=useMemo(()=>new THREE.MeshStandardMaterial({color:'#303c3e',roughness:.94,bumpMap:textures.stone.bumpMap,bumpScale:.008}),[textures])
 const urn=useMemo(()=>new THREE.LatheGeometry([[.1,0],[.12,.04],[.075,.1],[.12,.19],[.14,.26],[.13,.29],[.105,.29],[.1,.23],[.06,.12]].map(([x,y])=>new THREE.Vector2(x,y)),20),[])
 useEffect(()=>{
  const d=new THREE.Object3D()
  const random=(n:number)=>{const x=Math.sin(n*127.1)*43758.54;return x-Math.floor(x)}
  ;[[needles.current,c.needleAmount],[leaves.current,c.leafAmount]].forEach(([mesh,count],kind)=>{
   const m=mesh as THREE.InstancedMesh
   for(let i=0;i<(count as number);i++){
    d.position.set((random(i*5+1)-.5)*(c.width-.2),.055+random(i+700)*.009,.18+random(i*5+2)*(c.length-.3))
    d.rotation.set(0,random(i*5+3)*Math.PI*2,(random(i+800)-.5)*.1)
    const size=.65+random(i*5+4)*.65; if(kind)d.scale.set(.025*size,.003*size,.055*size);else d.scale.setScalar(size);d.updateMatrix();m.setMatrixAt(i,d.matrix)
    m.setColorAt(i,new THREE.Color(kind ? ['#786345','#695842','#8b7047'][i%3]:'#5e5037'))
   }
   m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true
  })
  return ()=>{stone.dispose();borderStone.dispose();plaqueStone.dispose();urn.dispose()}
 },[c,stone,borderStone,plaqueStone,urn])
 useFrame(({clock})=>{
  if(seq.exploration.nearMain>.58&&armed.current){playMainGraveRumble();armed.current=false}
  const success=seq.ending.outcome==='success'
  if(lid.current)lid.current.rotation.x=success?-smoothstep(.7,.86,seq.ending.progress)*.65:0
  if(root.current)root.current.rotation.z=Math.sin(clock.elapsedTime*32)*smoothstep(.72,.91,seq.exploration.storyProgress)*(1-smoothstep(.985,1,seq.exploration.storyProgress))*.003
 })
 const block=(key:string,position:[number,number,number],size:[number,number,number])=><RoundedBox key={key} position={position} args={size} radius={.018} smoothness={2} material={key.startsWith('side')||key.startsWith('end')?borderStone:key==='plaque'?plaqueStone:stone} castShadow receiveShadow/>
 return <group ref={root} position={[0,groundHeight(0,-83)+.06,-83]} scale={c.scale}>
  {/* A thick dusty apron sinks into the soil and supports every edge. */}
  <mesh position={[0,-.10,.85]} receiveShadow><boxGeometry args={[2.3,.24,3.1]}/><meshStandardMaterial color="#777366" map={textures.stone.map} bumpMap={textures.stone.bumpMap} bumpScale={.06} roughness={1}/></mesh>
  {[-1,1].map(side=>block('side'+side,[side*(c.width/2+c.border/2),.055,c.length/2],[c.border,.22,c.length+c.border*2]))}
  {[0,c.length].map(z=>block('end'+z,[0,.055,z],[c.width,.22,c.border]))}
  <mesh position={[0,-.015,c.length/2]} receiveShadow><boxGeometry args={[c.width,.13,c.length-.12]}/><meshStandardMaterial color="#342c21" map={textures.soil.map} bumpMap={textures.soil.bumpMap} bumpScale={.055} roughness={1}/></mesh>
  {block('base',[0,.12,-.15],[.58,.28,.4])}
  {block('cross',[0,.28+c.crossHeight/2,-.15],[.14,c.crossHeight,.16])}
  {block('arms',[0,.28+c.crossHeight*.73,-.15],[.65,.14,.16])}
  {[-1,1].map(side=><group key={side} position={[side*.43,.02,-.12]}><mesh geometry={urn} material={stone} castShadow receiveShadow/><mesh position={[0,.24,0]} rotation={[-Math.PI/2,0,0]}><circleGeometry args={[.105,16]}/><meshStandardMaterial color="#30291e"/></mesh></group>)}
  {/* Dried wreath hangs from the cross, with irregular desaturated foliage. */}
  <mesh position={[0,1.08,-.04]}><torusGeometry args={[.19,.022,6,28]}/><meshStandardMaterial color="#574532" roughness={1}/></mesh>
  {Array.from({length:18},(_,i)=>{const a=i/18*Math.PI*2;return <mesh key={i} position={[Math.cos(a)*.19,1.08+Math.sin(a)*.19,-.01]} rotation={[0,0,-a]} scale={[.022,.065,.012]}><octahedronGeometry args={[1,0]}/><meshStandardMaterial color={i%3?'#756744':'#8b7850'} roughness={1}/></mesh>})}
  {/* A separate hinged plaque keeps the inscription and revival animation intact. */}
  <group ref={lid} position={[0,.07,.35]}>
   {block('plaque',[0,.4,0],[.86,.8,.12])}
   <group scale={[.32,.25,.1]} position={[0,-.01,.035]}><GraveInscription/></group>
  </group>
  <instancedMesh ref={needles} args={[undefined,undefined,c.needleAmount]}><boxGeometry args={[.003,.002,.09]}/><meshStandardMaterial roughness={1}/></instancedMesh>
  <instancedMesh ref={leaves} args={[undefined,undefined,c.leafAmount]} receiveShadow><sphereGeometry args={[1,5,3]}/><meshStandardMaterial roughness={1}/></instancedMesh>
  {[['#ab8834',-.17,.9],['#843c37',.14,1.2],['#8c7860',-.05,1.45]].map(([color,x,z],i)=><group key={i} position={[x as number,.07,z as number]} rotation={[0,i*.6,0]}>
   <mesh position={[0,0,-.14]}><boxGeometry args={[.008,.008,.3]}/><meshStandardMaterial color="#56553a"/></mesh>
   {Array.from({length:5},(_,j)=><mesh key={j} position={[Math.cos(j*1.256)*.035,0,Math.sin(j*1.256)*.035]} scale={[.03,.012,.045]}><sphereGeometry args={[1,6,4]}/><meshStandardMaterial color={color as string} roughness={1}/></mesh>)}
  </group>)}
  <WaxCandle position={[-.32,.19,.2]} scale={.38}/>
  <pointLight position={[-2,4,1]} color="#ffe0ad" intensity={6} distance={8} decay={2}/>
 </group>
}
