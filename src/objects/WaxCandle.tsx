import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createGlowTexture } from '../utils/proceduralTextures'

export const atmosphereSettings = { flameIntensity: 0.8, flickerSpeed: 1.8, webDensity: 10, webOpacity: 0.48, shadowCandles: 2 }
const candles = new Set<THREE.Group>()
const point = new THREE.Vector3()
export function WaxCandle({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const root = useRef<THREE.Group>(null)
  const flame = useRef<THREE.Sprite>(null)
  const halo = useRef<THREE.Sprite>(null)
  const waxParts = useRef<THREE.InstancedMesh>(null)
  const resources = useMemo(() => {
    // A gently collapsed lip and translucent ivory wax.
    const body = new THREE.CylinderGeometry(.11,.14,.72,20,5)
    const a=body.attributes.position
    for(let i=0;i<a.count;i++) if(a.getY(i)>.3) a.setY(i,a.getY(i)+Math.sin(Math.atan2(a.getZ(i),a.getX(i))*3)*.012)
    body.computeVertexNormals()
    const wax = new THREE.MeshPhysicalMaterial({color:'#efe0bd',roughness:.35,transmission:0,thickness:1,ior:1.4,attenuationColor:new THREE.Color('#ffb347'),attenuationDistance:.7,emissive:'#b35b20',emissiveIntensity:.07})
    const wick=new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0,.35,0),new THREE.Vector3(.008,.4,0),new THREE.Vector3(.018,.42,0)]),8,.008,5,false)
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=128
    const ctx=canvas.getContext('2d')!
    // Soft teardrop alpha, with the cool combustion base beneath the yellow core.
    for(let y=0;y<128;y++) { const t=y/127,w=Math.sin(Math.PI*Math.pow(t,.7))*22
      const g=ctx.createLinearGradient(32-w,y,32+w,y)
      const c=t>.8?'180,215,255':t>.4?'255,225,120':'255,115,25'
      g.addColorStop(0,`rgba(${c},0)`);g.addColorStop(.5,`rgba(${c},.95)`);g.addColorStop(1,`rgba(${c},0)`)
      ctx.fillStyle=g;ctx.fillRect(32-w,y,w*2,1)
    }
    const texture=new THREE.CanvasTexture(canvas)
    return {body,wax,wick,texture}
  },[])
  useEffect(()=>{
    if(root.current) candles.add(root.current)
    const current=root.current
    const dummy=new THREE.Object3D()
    ;[[-.085,.2,.06,.022,.15],[.08,.26,.06,.018,.1]].forEach(([x,y,z,r,h],i)=>{dummy.position.set(x,y,z);dummy.scale.set(r,h,r);dummy.updateMatrix();waxParts.current?.setMatrixAt(i,dummy.matrix)})
    if(waxParts.current)waxParts.current.instanceMatrix.needsUpdate=true
    return ()=>{if(current)candles.delete(current);resources.body.dispose();resources.wax.dispose();resources.wick.dispose();resources.texture.dispose()}
  },[resources])
  useFrame(({clock,camera})=>{
    if(root.current){root.current.getWorldPosition(point);root.current.visible=point.distanceToSquared(camera.position)<900;if(!root.current.visible)return}
    const t=clock.elapsedTime*atmosphereSettings.flickerSpeed+position[0]*7
    const f=.88+Math.sin(t*7.1)*.07+Math.sin(t*13.7)*.04+Math.sin(t*23.3)*.025
    if(flame.current){flame.current.scale.set(.19,.32*f,1);flame.current.material.rotation=Math.sin(t*3)*.06}
    if(halo.current)halo.current.material.opacity=.13*f

  })
  return <group ref={root} position={position} scale={scale}>
    <mesh geometry={resources.body} material={resources.wax} castShadow receiveShadow />
    <instancedMesh ref={waxParts} args={[undefined,resources.wax,2]}><sphereGeometry args={[1,8,6]}/></instancedMesh>
    <mesh geometry={resources.wick}><meshStandardMaterial color="#211713" roughness={1}/></mesh>
    <sprite ref={flame} position={[0,.55,0]}><spriteMaterial map={resources.texture} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false}/></sprite>
    <sprite ref={halo} position={[0,.54,0]} scale={[1.2,1.2,1]}><spriteMaterial map={createGlowTexture(64)} color="#ffb347" transparent opacity={.13} depthWrite={false} blending={THREE.AdditiveBlending}/></sprite>
  </group>
}

/** A fixed light pool avoids one lighting pass and shader variant per candle. */
export function CandleLightPool() {
 const refs=useRef<(THREE.PointLight|null)[]>([])
 const chosen=useRef<THREE.Group[]>([])
 const next=useRef(0)
 useFrame(({clock,camera})=>{
  if(clock.elapsedTime>next.current){
   next.current=clock.elapsedTime+.35
   chosen.current=[...candles].map(c=>({c,d:c.getWorldPosition(new THREE.Vector3()).distanceToSquared(camera.position)})).filter(v=>v.d<225).sort((a,b)=>a.d-b.d).slice(0,2).map(v=>v.c)
  }
  refs.current.forEach((light,i)=>{if(!light)return;const candle=chosen.current[i];light.intensity=0;if(!candle)return
   candle.localToWorld(point.set(0,.52,0));light.position.copy(point)
   const t=clock.elapsedTime*atmosphereSettings.flickerSpeed+candle.position.x*7
   light.intensity=atmosphereSettings.flameIntensity*(.88+Math.sin(t*7.1)*.07+Math.sin(t*13.7)*.04+Math.sin(t*23.3)*.025)
  })
 })
 return <>{[0,1].map(i=><pointLight key={i} ref={v=>{refs.current[i]=v}} color="#ffb347" distance={5} decay={2} intensity={0}/>)}</>
}
