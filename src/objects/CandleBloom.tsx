import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/** Restrained bloom at half resolution keeps the flame halo inexpensive. */
export function CandleBloom() {
  const { gl, scene, camera, size } = useThree()
  const pipeline=useMemo(()=>{
    const composer=new EffectComposer(gl)
    const bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.18,.3,.85)
    const output=new OutputPass()
    composer.addPass(new RenderPass(scene,camera));composer.addPass(bloom);composer.addPass(output)
    return {composer,bloom,output}
  },[gl,scene,camera])
  useEffect(()=>{pipeline.composer.setPixelRatio(1);pipeline.composer.setSize(Math.max(1,Math.floor(size.width)),Math.max(1,Math.floor(size.height)))},[pipeline,size])
  useEffect(()=>()=>{pipeline.bloom.dispose();pipeline.output.dispose();pipeline.composer.dispose()},[pipeline])
  useFrame((_,delta)=>pipeline.composer.render(delta),1)
  return null
}
