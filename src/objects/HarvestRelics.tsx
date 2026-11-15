import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { batchStaticMeshes } from '../utils/batchStaticMeshes'
import { createCobwebGeometry } from '../utils/cobwebGeometry'
import { groundHeight } from './Ground'
import { seq } from '../animations/sequence'

const sites = [
  { x: -7.6, z: -33, yaw: .22 }, { x: 7.8, z: -56, yaw: -.3 },
  { x: -6.3, z: -84, yaw: .28 }, { x: 6.6, z: -85, yaw: -.25 },
]
export const relicObstacles = sites.map(({ x, z }) => ({ x, z, radius: 1.05 }))

/** Small funeral displays placed outside the walking route; static details share material batches. */
export function HarvestRelics() {
  const { groups, materials } = useMemo(() => {
    const wood = new THREE.MeshStandardMaterial({ color: '#46362c', roughness: .98 })
    const iron = new THREE.MeshStandardMaterial({ color: '#353735', roughness: .8, metalness: .5 })
    const earth = new THREE.MeshStandardMaterial({ color: '#282621', roughness: 1 })
    const leaf = new THREE.MeshStandardMaterial({ color: '#796143', roughness: 1 })
    const wax = new THREE.MeshStandardMaterial({ color: '#b9ab8c', roughness: .96 })
    const flame = new THREE.MeshBasicMaterial({ color: '#ffc386', toneMapped: false })
    const silk = new THREE.LineBasicMaterial({ color: '#9faeac', vertexColors: true, transparent: true, opacity: .28, depthWrite: false })
    const groups = sites.map((site,index) => {
      const root = new THREE.Group();root.position.set(site.x,groundHeight(site.x,site.z),site.z);root.rotation.y=site.yaw
      const add=(g:THREE.BufferGeometry,m:THREE.Material,p:number[],target=root)=>{
        const mesh=new THREE.Mesh(g,m);mesh.position.set(p[0],p[1],p[2]);mesh.receiveShadow=true;target.add(mesh);return mesh
      }
      const box=(size:number[],m:THREE.Material,p:number[],target=root)=>add(new THREE.BoxGeometry(...size as [number,number,number]),m,p,target)
      const tube=(path:number[][],radius:number,m:THREE.Material,target=root)=>add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path.map(p=>new THREE.Vector3(...p as [number,number,number]))),20,radius,5,false),m,[0,0,0],target)
      const coffin=new THREE.Group();coffin.rotation.z=index%2?.12:-.14;coffin.rotation.x=-.11;root.add(coffin)
      const outline=new THREE.Shape()
      outline.moveTo(-.27,0);outline.lineTo(-.46,1.38);outline.lineTo(-.32,1.94)
      outline.lineTo(.32,1.94);outline.lineTo(.46,1.38);outline.lineTo(.27,0);outline.closePath()
      add(new THREE.ExtrudeGeometry(outline,{depth:.22,bevelEnabled:true,bevelSize:.022,bevelThickness:.02,bevelSegments:1}),wood,[0,.04,0],coffin)
      // Narrow seams, forged straps and old nails make this read as weathered timber.
      for(const x of [-.16,0,.16])box([.008,1.83,.009],iron,[x,.99,.247],coffin)
      for(const y of [.35,1.48]) {
        box([y>1?.84:.6,.045,.023],iron,[0,y,.26],coffin)
        for(const side of [-1,1])add(new THREE.SphereGeometry(.016,6,4),iron,[side*(y>1?.36:.25),y,.28],coffin)
      }
      box([.065,.65,.025],iron,[0,1.11,.267],coffin);box([.34,.065,.025],iron,[0,1.27,.267],coffin)
      const web=new THREE.LineSegments(createCobwebGeometry(53+index,.47),silk);web.position.set(.13,1.58,.29);coffin.add(web)
      const mound=add(new THREE.SphereGeometry(1,16,8),earth,[0,-.06,.28]);mound.scale.set(1.08,.18,.65)
      // Dried funeral wreath leaning against the coffin, with irregular twig tips.
      const wreath=add(new THREE.TorusGeometry(.27,.024,5,32),wood,[-.57,.35,.45]);wreath.rotation.set(-.2,.2,.3)
      for(let i=0;i<18;i++) {
        const a=i/18*Math.PI*2,x=-.57+Math.cos(a)*.28,y=.35+Math.sin(a)*.28
        const sprig=add(new THREE.OctahedronGeometry(.075,0),leaf,[x,y,.46]);sprig.scale.set(.4,1.5,.25);sprig.rotation.z=-a
      }
      for(let i=0;i<5;i++) {
        const x=.52+(i%3)*.16,z=.35+Math.floor(i/3)*.22,h=.19+(i%3)*.14
        add(new THREE.CylinderGeometry(.045,.055,h,10),wax,[x,h/2,z])
        const fire=add(new THREE.SphereGeometry(.025,8,6),flame,[x,h+.04,z]);fire.scale.y=1.9
        add(new THREE.CylinderGeometry(.075,.08,.014,10),wax,[x,.012,z])
      }
      // A low twisted branch and scattered fallen leaves anchor the display.
      tube([[-.9,.04,.5],[-.4,.05,.8],[.2,.035,.85],[.62,.06,1]],.025,wood)
      for(let i=0;i<14;i++) {
        const piece=add(new THREE.OctahedronGeometry(.09,0),leaf,[Math.sin(i*2.4)*1.1,.025,.6+Math.cos(i*2.4)*.5])
        piece.scale.set(1.2,.12,.5);piece.rotation.y=i*1.7
      }
      batchStaticMeshes(root)
      return root
    })
    return { groups, materials: [wood,iron,earth,leaf,wax,flame,silk] }
  },[])
  useFrame(({camera})=>groups.forEach((group,index)=>{
    group.visible=seq.reveal.trees>.35&&Math.hypot(camera.position.x-sites[index].x,camera.position.z-sites[index].z)<42
  }))
  useEffect(()=>()=>{
    const geometry=new Set<THREE.BufferGeometry>()
    groups.forEach(group=>group.traverse(node=>{if((node as THREE.Mesh).geometry)geometry.add((node as THREE.Mesh).geometry)}))
    geometry.forEach(g=>g.dispose());materials.forEach(m=>m.dispose())
  },[groups,materials])
  return <group>{groups.map((group,index)=><primitive key={index} object={group}/>)}</group>
}
