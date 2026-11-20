import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { groundHeight } from './Ground'
import { createStoneTextures } from '../utils/proceduralTextures'

const plots: [number,number][]=[[-8.5,-24],[10,-35],[-12.5,-48],[13.5,-58],[-9,-68],[9,-73]]
/** The avenue and six branching approaches share geometry and one draw call. */
export function ProcessionalPath() {
 const stones=useRef<THREE.InstancedMesh>(null)
 const textures=useMemo(()=>createStoneTextures(128),[])
 const placements=useMemo(()=>{
  const result:{x:number;z:number;yaw:number;size:number}[]=[]
  // Carry the main route right up to the final grave's apron.
  for(let row=0;row<29;row++)for(const side of [-1,1]){
   const t=row/28
   const z=-15-t*60.36+Math.sin(row*2.1+side)*.14
   const bend=Math.sin(t*Math.PI*2)*.55
   result.push({x:bend+side*(.46+Math.sin(row*1.7)*.045)+Math.sin(row*7+side)*.07,z,yaw:Math.sin(row*11+side)*.16,size:.50+Math.sin(row*3+side)*.025})
  }
  plots.forEach(([x,z],plot)=>{
   const yaw=Math.sin(plot*3.8)*.28
   const endX=x+Math.sin(yaw)*2.55,endZ=z+Math.cos(yaw)*2.55
   // Bend toward the opening in the front of each iron enclosure.
   const startZ=z+5.4
   const startX=Math.sin(((-15-startZ)/60.36)*Math.PI*2)*.55+Math.sign(x)*1.05
   const curve=new THREE.CubicBezierCurve3(new THREE.Vector3(startX,0,startZ),new THREE.Vector3(x*.5,0,startZ+.3),new THREE.Vector3(endX+Math.sin(yaw)*1.6,0,endZ+Math.cos(yaw)*1.6),new THREE.Vector3(endX,0,endZ))
   const count=Math.ceil(curve.getLength()/1.7)
   for(let i=0;i<=count;i++){
    const t=i/count,p=curve.getPointAt(t),direction=curve.getTangentAt(t)
    if(result.every(other=>(other.x-p.x)**2+(other.z-p.z)**2>.55**2))result.push({x:p.x,z:p.z,yaw:Math.atan2(direction.x,direction.z)+Math.sin(i*7+plot)*.09,size:.43})
   }
  })
  return result
 },[])
 useEffect(()=>()=>{textures.map.dispose();textures.bumpMap.dispose()},[textures])
 useLayoutEffect(()=>{
  if(!stones.current)return
  const d=new THREE.Object3D(),color=new THREE.Color()
  placements.forEach((p,i)=>{
   // Embed the bottom; gentle pitch follows the actual triangulated ground.
   const dx=(groundHeight(p.x+.2,p.z)-groundHeight(p.x-.2,p.z))/.4
   const dz=(groundHeight(p.x,p.z+.2)-groundHeight(p.x,p.z-.2))/.4
   d.position.set(p.x,groundHeight(p.x,p.z)-.035,p.z)
   d.rotation.set(Math.atan(dz),p.yaw,-Math.atan(dx))
   d.scale.set(p.size,.15,p.size*1.15);d.updateMatrix()
   stones.current!.setMatrixAt(i,d.matrix)
   stones.current!.setColorAt(i,color.setHSL(.12,.08,.46+(i%5)*.018))
  })
  stones.current.instanceMatrix.needsUpdate=true
  if(stones.current.instanceColor)stones.current.instanceColor.needsUpdate=true
  stones.current.computeBoundingSphere()
 },[placements])
 return <instancedMesh ref={stones} args={[undefined,undefined,placements.length]} receiveShadow>
  <cylinderGeometry args={[1,1.06,1,7]}/>
  <meshStandardMaterial map={textures.map} bumpMap={textures.bumpMap} bumpScale={.035} roughness={.96}/>
 </instancedMesh>
}
