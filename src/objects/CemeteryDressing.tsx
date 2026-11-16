import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { groundHeight } from './Ground'
import { createRustTextures, createStoneTextures } from '../utils/proceduralTextures'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { WaxCandle } from './WaxCandle'
import { seq } from '../animations/sequence'

// Grouped set dressing stays outside the avenue, grave entrances and ritual stage.
const sites = [
 {x:5.4,z:-25,yaw:-.35,type:0}, {x:-5.5,z:-38,yaw:.6,type:1},
 {x:5.8,z:-51,yaw:-.2,type:2}, {x:-5.8,z:-63,yaw:.4,type:0},
 {x:-8,z:-88,yaw:.3,type:2}, {x:8.2,z:-90,yaw:-.6,type:1},
]
export const dressingObstacles=sites.map(s=>({x:s.x,z:s.z,radius:1.2}))

/** Weathered props share material batches; no additional point lights or shadow maps. */
export function CemeteryDressing(){
 const data=useMemo(()=>{
  const rust=createRustTextures(128),stoneTexture=createStoneTextures(128)
  // Fine directional grain helps the timber read as old planks, not solid blocks.
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=256
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='#75614a';ctx.fillRect(0,0,128,256)
  for(let i=0;i<150;i++){
   const x=(i*47)%128;ctx.strokeStyle=i%3?'#584737':'#968269';ctx.globalAlpha=.22
   ctx.beginPath();ctx.moveTo(x,0);ctx.bezierCurveTo(x+Math.sin(i)*4,80,x-3,170,x+2,256);ctx.stroke()
  }
  const grain=new THREE.CanvasTexture(canvas);grain.colorSpace=THREE.SRGBColorSpace
  const wood=new THREE.MeshStandardMaterial({map:grain,bumpMap:grain,bumpScale:.014,color:'#b3a28b',roughness:.95})
  const iron=new THREE.MeshStandardMaterial({map:rust.map,bumpMap:rust.bumpMap,bumpScale:.025,color:'#9d8a74',roughness:.86,metalness:.35})
  const stone=new THREE.MeshStandardMaterial({map:stoneTexture.map,bumpMap:stoneTexture.bumpMap,bumpScale:.025,color:'#aaa394',roughness:.96})
  const dry=new THREE.MeshStandardMaterial({color:'#7a6b49',roughness:1,side:THREE.DoubleSide})
  const orange=new THREE.MeshStandardMaterial({color:'#886035',roughness:.83})
  const earth=new THREE.MeshStandardMaterial({color:'#302b24',roughness:1})
  const groups=sites.map((site,index)=>{
   const root=new THREE.Group()
   const add=(g:THREE.BufferGeometry,m:THREE.Material,p:number[],target=root)=>{
    const mesh=new THREE.Mesh(g,m);mesh.position.set(p[0],p[1],p[2]);mesh.receiveShadow=true;target.add(mesh);return mesh
   }
   const box=(size:number[],m:THREE.Material,p:number[],target=root)=>add(new THREE.BoxGeometry(...size as [number,number,number]),m,p,target)
   const tube=(points:number[][],r:number,m:THREE.Material,target=root)=>add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p as [number,number,number]))),10,r,5,false),m,[0,0,0],target)
   if(site.type===0){
    // Open slatted tool crate with iron nails, a leaning spade and a coiled rope.
    for(let j=0;j<4;j++){
     for(const side of [-1,1])box([.78,.075,.045],wood,[0,.07+j*.095,side*.3])
     box([.15,.035,.61],wood,[-.27+j*.18,.025,0])
    }
    for(const x of [-.36,.36])for(const z of [-.28,.28]){
     box([.045,.43,.045],wood,[x,.2,z])
     for(const y of [.09,.29])add(new THREE.SphereGeometry(.012,5,4),iron,[x,y,z+Math.sign(z)*.03])
    }
    const tool=new THREE.Group();tool.position.set(.58,0,-.14);tool.rotation.z=-.17;root.add(tool)
    const blade=new THREE.Shape();blade.moveTo(-.12,.3);blade.lineTo(.12,.3);blade.lineTo(.14,.07);blade.quadraticCurveTo(0,-.03,-.14,.07);blade.closePath()
    add(new THREE.ExtrudeGeometry(blade,{depth:.018,bevelEnabled:true,bevelSize:.008,bevelThickness:.005,bevelSegments:1}),iron,[0,0,0],tool)
    add(new THREE.CylinderGeometry(.018,.023,.9,8),wood,[0,.73,0],tool)
    const grip=add(new THREE.TorusGeometry(.07,.013,5,16),iron,[0,1.23,0],tool);grip.scale.y=1.2
    for(let ring=0;ring<4;ring++){
     const rope=add(new THREE.TorusGeometry(.13+ring*.018,.009,4,22),dry,[-.12,.04+ring*.008,.55]);rope.rotation.x=Math.PI/2
    }
    for(let i=0;i<3;i++){const board=box([.12,.025,.65],wood,[-.65+i*.13,.03+i*.015,.25]);board.rotation.y=-.4+i*.13}
   }else if(site.type===1){
    // Hollow broken urn and a worn memorial bench, with separate ceramic shards.
    const profile=[[.14,0],[.17,.055],[.1,.15],[.22,.3],[.23,.44],[.19,.49],[.16,.49],[.19,.4],[.18,.3],[.075,.15]].map(([x,y])=>new THREE.Vector2(x,y))
    add(new THREE.LatheGeometry(profile,20,.18,Math.PI*1.72),stone,[-.45,0,.25])
    for(let i=0;i<5;i++){
     const shard=add(new THREE.CircleGeometry(.07,3),stone,[-.45+Math.sin(i*2.4)*.38,.018,.55+Math.cos(i*2.4)*.19]);shard.rotation.set(-Math.PI/2,0,i);shard.scale.x=1.4
    }
    for(const x of [-.38,.38])box([.15,.38,.3],stone,[x,.16,-.35])
    box([1.18,.09,.38],stone,[0,.38,-.35])
    for(let i=0;i<7;i++)tube([[.2,.035,.25],[.3+i*.025,.04,.55],[.48+i*.03,.05,.7]],.005,dry)
   }else{
    // Small muted gourds have ribbed skins and crooked woody stems.
    for(let i=0;i<3;i++){
     const size=.14+i*.035,x=-.4+i*.32,z=(i%2)*.22
     const geometry=new THREE.SphereGeometry(size,24,14)
     const a=geometry.attributes.position
     for(let v=0;v<a.count;v++){
      const angle=Math.atan2(a.getZ(v),a.getX(v)),rib=1+Math.cos(angle*9)*.065
      a.setXYZ(v,a.getX(v)*rib,a.getY(v)*.82,a.getZ(v)*rib)
     }geometry.computeVertexNormals()
     add(geometry,i===1?dry:orange,[x,size*.78-.02,z])
     tube([[x,size*1.5,z],[x+.02,size*1.7,z],[x+.055,size*1.8,z-.015]],.018,wood)
    }
    // Bound dried stalks and a fallen broom make a harvest offering.
    for(let i=0;i<12;i++){
     const x=.55+Math.sin(i*2.4)*.09,z=-.3+Math.cos(i*2.4)*.07
     tube([[x,0,z],[.55,.44,-.3],[x+.07,.8+(i%4)*.06,z]],.006,dry)
    }
    const tie=add(new THREE.TorusGeometry(.055,.009,4,16),wood,[.55,.43,-.3]);tie.rotation.x=Math.PI/2
    tube([[-.6,.025,.4],[-.1,.04,.65],[.25,.035,.83]],.016,wood)
    for(let i=0;i<9;i++)tube([[.15,.04,.78],[.4+(i-4)*.025,.025,1]],.005,dry)
   }
   // Common grounding details: damp soil skirts and small fragments along the edges.
   const skirt=add(new THREE.SphereGeometry(1,16,6),earth,[0,-.095,.15]);skirt.scale.set(1.05,.13,.85)
   for(let i=0;i<15;i++){
    const a=i*2.399,leaf=add(new THREE.PlaneGeometry(.045,.11),dry,[Math.cos(a)*(.65+(i%3)*.1),.012,.2+Math.sin(a)*.65]);leaf.rotation.set(-Math.PI/2,.15,i)
   }
   // Bake each mesh to local coordinates, then conform its base to the actual terrain.
   root.updateMatrixWorld(true)
   root.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.applyMatrix4(node.matrixWorld);node.position.set(0,0,0);node.rotation.set(0,0,0);node.scale.set(1,1,1)}})
   // Flatten nested transforms now that geometry owns them.
   const meshes:THREE.Mesh[]=[];root.traverse(n=>{if(n instanceof THREE.Mesh)meshes.push(n)})
   meshes.forEach(m=>root.add(m));root.children.filter(n=>!(n instanceof THREE.Mesh)).forEach(n=>root.remove(n))
   for(const m of meshes){const a=m.geometry.attributes.position
    for(let v=0;v<a.count;v++){
     const x=a.getX(v),z=a.getZ(v),wx=site.x+x*Math.cos(site.yaw)+z*Math.sin(site.yaw),wz=site.z-x*Math.sin(site.yaw)+z*Math.cos(site.yaw)
     a.setY(v,a.getY(v)+groundHeight(wx,wz)-groundHeight(site.x,site.z))
    }m.geometry.computeVertexNormals()
   }
   batchStaticMeshes(root)
   root.position.set(site.x,groundHeight(site.x,site.z),site.z);root.rotation.y=site.yaw
   return root
  })
  return {groups,materials:[wood,iron,stone,dry,orange,earth],textures:[grain,rust.map,rust.bumpMap,stoneTexture.map,stoneTexture.bumpMap]}
 },[])
 useFrame(({camera})=>data.groups.forEach((g,i)=>{g.visible=seq.reveal.trees>.3&&Math.hypot(camera.position.x-sites[i].x,camera.position.z-sites[i].z)<40}))
 useEffect(()=>()=>{data.groups.forEach(g=>g.traverse(n=>{if(n instanceof THREE.Mesh)n.geometry.dispose()}));data.materials.forEach(m=>m.dispose());data.textures.forEach(t=>t.dispose())},[data])
 return <>{data.groups.map((g,i)=><primitive key={i} object={g}/>)}{sites.filter(s=>s.type===1).map((s,i)=><WaxCandle key={i} position={[s.x+.65,groundHeight(s.x+.65,s.z+.4)+.12,s.z+.4]} scale={.33}/>)}</>
}
