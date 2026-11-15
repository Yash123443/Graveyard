import * as THREE from 'three'
import { batchStaticMeshes } from '../../utils/batchStaticMeshes'

type SoulVariant = 'analyst' | 'fixer' | 'tester'
interface SoulOptions { variant?: SoulVariant; rotY?: number; scale?: number; lightIntensity?: number; lightDistance?: number }
const smooth = (v: number) => { const t = THREE.MathUtils.clamp(v, 0, 1); return t * t * (3 - 2 * t) }

/** Small, deterministic PBR surface maps. Generated once, never in the frame loop. */
function weatheredSurface(kind: 'cloth' | 'skin' | 'rust' | 'hair', tint: string, lace = false) {
  const size = 256, albedo = new Uint8Array(size * size * 4), relief = new Uint8Array(size * size * 4)
  const base = new THREE.Color(tint).convertLinearToSRGB()
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return n - Math.floor(n)
  }
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy)
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), u), THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), u), v)
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, grain = hash(x, y)
    const stain = noise(u * 7, v * 9) * .65 + noise(u * 21, v * 24) * .35
    const warp = Math.sin(x * Math.PI / 2) * Math.sin(y * Math.PI / 2)
    const vein = kind === 'skin' ? Math.pow(Math.max(0, 1 - Math.abs(Math.sin(u * 47 + Math.sin(v * 21) * 2.4)) * 14), 2) * (0.2 + stain * .8) : 0
    const ornament = lace ? Math.pow(Math.abs(Math.sin(u * Math.PI * 12 + Math.sin(v * Math.PI * 20)) * Math.cos(v * Math.PI * 16)), 10) : 0
    const strand = .5 + .5 * Math.sin(v * 530 + Math.sin(u * 18) * .5)
    const value = kind === 'hair' ? .45 + strand * .45 + stain * .1 : kind === 'skin' ? .75 + stain * .3 - vein * .23 : .36 + stain * .64 + warp * .055 - ornament * .3
    const rust = kind === 'rust' ? smooth((stain - .42) * 3) : 0
    const n = (y * size + x) * 4
    albedo.set([
      Math.min(255, base.r * value * 255 + rust * 75),
      Math.min(255, base.g * value * 255 + rust * 27 + vein * 5),
      Math.min(255, base.b * value * 255 + rust * 6 + vein * 9), 255,
    ], n)
    const height = Math.round(THREE.MathUtils.clamp(kind === 'hair' ? strand : .45 + (grain - .5) * .2 + warp * .16 + stain * .24 - ornament * .3 - vein * .1, 0, 1) * 255)
    relief.set([height, kind === 'hair' ? 170 : kind === 'skin' ? 230 : 205 + Math.round(stain * 35), height, 255], n)
  }
  const map = new THREE.DataTexture(albedo, size, size), bump = new THREE.DataTexture(relief, size, size)
  for (const texture of [map, bump]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.generateMipmaps = true; texture.needsUpdate = true
  }
  map.colorSpace = THREE.SRGBColorSpace
  return { map, bump }
}

/** Three fully volumetric characters, with shared material batches and GPU cloth motion. */
export function createWitchSoul(parent: THREE.Group, options: SoulOptions = {}) {
  const variant = options.variant ?? 'analyst'
  const accent = new THREE.Color(variant === 'analyst' ? '#a9efff' : variant === 'tester' ? '#de83ff' : '#ffb05b')
  const root = new THREE.Group(), body = new THREE.Group(), lantern = new THREE.Group()
  parent.add(root); root.add(body); root.rotation.y = options.rotY ?? 0; root.scale.setScalar(options.scale ?? 1)
  const materials: THREE.Material[] = [], textures: THREE.Texture[] = []
  const standard = (color: string, roughness = 0.88) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, transparent: true, opacity: 0 })
    materials.push(m); return m
  }
  const fabric = standard('#ffffff', 0.98)
  const dark = standard('#010203')
  const iron = standard('#ffffff', 0.84); iron.metalness = 0.38
  const bone = standard('#9a9582', 0.92)
  for (const [material, surface] of [
    [fabric, weatheredSurface('cloth', '#333a38')],
    [iron, weatheredSurface('rust', '#3e4240')],
  ] as const) {
    material.map = surface.map; material.bumpMap = surface.bump; material.bumpScale = .023
    material.roughnessMap = surface.bump
    textures.push(surface.map, surface.bump)
  }
  const wax = standard('#d9bd8b')
  const bubbles: THREE.Mesh[] = []
  const glow = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, toneMapped: false, depthWrite: false })
  const eyes = new THREE.MeshBasicMaterial({ color: variant === 'analyst' ? '#93bfc7' : variant === 'tester' ? '#aa7bc4' : '#9c1c15', transparent: true, opacity: 0, toneMapped: false })
  materials.push(glow, eyes)
  fabric.side = THREE.DoubleSide; fabric.forceSinglePass = true
  // All three use the approved black shroud, including its original subtle warmth.
  fabric.emissive.set('#ffb05b'); fabric.emissiveIntensity = .002
  const timeUniform = { value: 0 }
  for (const m of [fabric]) {
    m.onBeforeCompile = shader => {
      shader.uniforms.soulTime = timeUniform
      shader.vertexShader = 'uniform float soulTime; varying vec3 soulPosition;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        float loose = 1.0 - smoothstep(0.1, 1.8, position.y);
        transformed.x += sin(position.y * 3.4 + position.z * 4.0 + soulTime * 0.85) * 0.045 * loose;
        transformed.z += sin(position.x * 4.5 + soulTime * 0.65) * 0.025 * loose;
        soulPosition = position;
      `)
      shader.fragmentShader = 'varying vec3 soulPosition;\n' + shader.fragmentShader
      if (m === fabric) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
          float fray = sin(soulPosition.x * 137.0 + sin(soulPosition.y * 31.0)) * sin(soulPosition.y * 93.0 + soulPosition.z * 75.0);
          float decay = 1.0 - smoothstep(0.15, 1.15, soulPosition.y);
          float hem = smoothstep(-0.16, 0.38, soulPosition.y + fray * 0.065);
          diffuseColor.a *= hem;
          if (fray > 0.94 - decay * 0.12 && soulPosition.y < 1.26) discard;
          #include <alphatest_fragment>
        `)
      }
    }
    m.customProgramCacheKey = () => 'black-reaper-cloth-v1'
  }
  const add = (g: THREE.BufferGeometry, m: THREE.Material, p: number[], target = body) => {
    const mesh = new THREE.Mesh(g, m); mesh.position.set(p[0], p[1], p[2]); target.add(mesh)
    mesh.castShadow = false; mesh.receiveShadow = true; return mesh
  }
  const ellipsoid = (p: number[], scale: number[], m: THREE.Material, target = body) => {
    const mesh = add(new THREE.SphereGeometry(1, 24, 16), m, p, target); mesh.scale.set(scale[0], scale[1], scale[2]); return mesh
  }
  const tube = (points: number[][], radius: number, m: THREE.Material, target = body, taper = 1) => {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])))
    const geometry = new THREE.TubeGeometry(curve, 24, radius, 8, false)
    if (taper !== 1) {
      const pos = geometry.attributes.position, uv = geometry.attributes.uv
      for (let i = 0; i < pos.count; i++) {
        const u = uv.getX(i), center = curve.getPointAt(u), factor = THREE.MathUtils.lerp(1, taper, u * u)
        pos.setXYZ(i, center.x + (pos.getX(i) - center.x) * factor, center.y + (pos.getY(i) - center.y) * factor, center.z + (pos.getZ(i) - center.z) * factor)
      }
      geometry.computeVertexNormals()
    }
    return add(geometry, m, [0, 0, 0], target)
  }
  const ribbon = (points: number[][], width: number, phase: number) => {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p as [number, number, number])))
    const positions: number[] = [], uv: number[] = [], index: number[] = []
    for (let j = 0; j <= 28; j++) {
      const t = j / 28, center = curve.getPoint(t), fray = 1 + Math.sin(j * 2.7 + phase * 13) * .12 * t
      const w = width * (0.85 + Math.sin(t * Math.PI) * 0.3) * Math.pow(1 - t, 0.65) * fray
      const twist = phase + Math.sin(t * 4 + phase) * 0.55
      for (let i = 0; i <= 6; i++) {
        const u = i / 6 * 2 - 1, fold = Math.sin(u * Math.PI) * w * 0.2
        positions.push(center.x + Math.cos(twist) * u * w, center.y + Math.sin(u * Math.PI) * w * 0.12, center.z + Math.sin(twist) * u * w + fold)
        uv.push(i / 6, t)
        if (j < 28 && i < 6) { const n = j * 7 + i; index.push(n, n + 7, n + 1, n + 1, n + 7, n + 8) }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(index); g.computeVertexNormals()
    add(g, fabric, [0, 0, 0])
  }
  {
    const robe = new THREE.LatheGeometry(new THREE.SplineCurve([new THREE.Vector2(.52,0),new THREE.Vector2(.46,.35),new THREE.Vector2(.35,1),new THREE.Vector2(.28,1.35),new THREE.Vector2(.4,1.65),new THREE.Vector2(.23,1.85)]).getPoints(32),48)
    const pos=robe.attributes.position
    for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),a=Math.atan2(x,z),fold=1+Math.sin(a*9+y)*.09;pos.setXYZ(i,x*fold,y+Math.sin(a*11)*.035*Math.exp(-y*6),z*fold*.72)}
    robe.computeVertexNormals();add(robe,fabric,[0,0,0])
    const vertices:number[]=[],uv:number[]=[],indices:number[]=[]
    for(let j=0;j<=20;j++)for(let i=0;i<=48;i++){
      const v=j/20,a=i/48*Math.PI*2,r=1-v*.95
      const peak=Math.pow(Math.max(0,Math.cos(a)),8)*.075
      vertices.push(Math.sin(a)*.29*r,2.03+(Math.cos(a)*.38+peak)*r+v*.25,.22-v*.57+Math.sin(a*9)*.012*r);uv.push(i/48,v)
      if(j<20&&i<48){const n=j*49+i;indices.push(n,n+49,n+1,n+1,n+49,n+50)}
    }
    const hood=new THREE.BufferGeometry();hood.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));hood.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));hood.setIndex(indices);hood.computeVertexNormals();add(hood,fabric,[0,0,0])
    ellipsoid([0,2.04,-.01],[.22,.3,.13],dark)
    for(const side of [-1,1]) ellipsoid([side*.082,2.1,.13],[.018,.014,.011],eyes)
    tube([[-.32,1.65,0],[-.52,1.4,.15],[-.65,1.4,.36]],.12,fabric)
    tube([[.32,1.65,0],[.43,1.2,.06],[.4,.86,.12]],.11,fabric)
    ellipsoid([-.65,1.415,.38],[.055,.025,.045],bone)
    for(let i=0;i<4;i++) {
      const x=-.7+i*.024
      tube([[x,1.43,.39],[x-.008,1.4,.46],[x-.006,1.365,.47],[x+.004,1.36,.435]],.009,bone,body,.65)
      ellipsoid([x-.008,1.4,.46],[.012,.012,.012],bone)
    }
    tube([[-.6,1.43,.37],[-.58,1.39,.42],[-.62,1.375,.445]],.013,bone,body,.7)
    body.add(lantern);lantern.position.set(-.67,1.4,.43)
    if (variant === 'fixer') {
      // Cut the face out of the ribbed shell so the candle glow comes from inside.
      const pumpkin = standard('#bd5719', .84)
      const rind = standard('#673009', .95);rind.side=THREE.BackSide
      const stem = standard('#4a4830', .96)
      const shell = new THREE.SphereGeometry(1,80,48)
      const p=shell.attributes.position, original=shell.index!, kept:number[]=[]
      const openings=[
        [[-.56,.12],[-.19,.13],[-.34,.48]],
        [[.19,.13],[.56,.12],[.34,.48]],
        [[-.61,-.19],[-.37,-.26],[-.31,-.17],[-.19,-.19],[-.18,-.32],
         [.04,-.34],[.08,-.22],[.2,-.21],[.25,-.3],[.61,-.19],[.47,-.49],
         [.27,-.59],[.2,-.49],[.06,-.51],[.02,-.63],[-.23,-.59],[-.45,-.45]],
      ]
      const inside=(x:number,y:number,polygon:number[][])=>{
        let hit=false
        for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
          const [ax,ay]=polygon[i],[bx,by]=polygon[j]
          if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)hit=!hit
        }
        return hit
      }
      for(let i=0;i<original.count;i+=3) {
        const a=original.getX(i),b=original.getX(i+1),c=original.getX(i+2)
        const x=(p.getX(a)+p.getX(b)+p.getX(c))/3,y=(p.getY(a)+p.getY(b)+p.getY(c))/3,z=(p.getZ(a)+p.getZ(b)+p.getZ(c))/3
        if(z>.45&&openings.some(outline=>inside(x,y,outline)))continue
        kept.push(a,b,c)
      }
      shell.setIndex(kept)
      for(let i=0;i<p.count;i++) {
        const x=p.getX(i),y=p.getY(i),z=p.getZ(i),a=Math.atan2(x,z)
        const rib=1+.065*Math.cos(a*10),shoulder=1-.1*Math.abs(y)**5
        p.setXYZ(i,x*.28*rib*shoulder,y*.235,z*.255*rib*shoulder)
      }
      shell.computeVertexNormals()
      add(shell,pumpkin,[0,-.34,0],lantern)
      const lining=shell.clone();lining.scale(.94,.94,.94);add(lining,rind,[0,-.34,0],lantern)
      ellipsoid([0,-.34,-.015],[.225,.19,.205],glow,lantern)
      tube([[0,-.115,0],[.012,-.065,-.015],[.045,-.04,-.025]],.025,stem,lantern,.68)
      tube([[-.235,-.25,0],[-.19,-.03,0],[0,.035,0],[.19,-.03,0],[.235,-.25,0]],.012,iron,lantern)
    } else if (variant === 'analyst') {
      // Sculpted cheekbones and a separate jaw frame deep, genuinely open sockets.
      const ivory=standard('#b1a78e',.95)
      const patina=weatheredSurface('cloth','#c4baa0');textures.push(patina.map,patina.bump)
      ivory.color.set('#ffffff');ivory.map=patina.map;ivory.bumpMap=patina.bump;ivory.bumpScale=.0015
      ellipsoid([0,-.22,-.045],[.153,.157,.125],ivory,lantern)
      const face=new THREE.Shape()
      face.moveTo(-.083,-.407);face.lineTo(-.09,-.365);face.lineTo(-.137,-.335)
      face.quadraticCurveTo(-.17,-.31,-.146,-.27)
      face.bezierCurveTo(-.17,-.18,-.138,-.105,-.075,-.093)
      face.quadraticCurveTo(0,-.075,.075,-.093)
      face.bezierCurveTo(.138,-.105,.17,-.18,.146,-.27)
      face.quadraticCurveTo(.17,-.31,.137,-.335);face.lineTo(.09,-.365);face.lineTo(.083,-.407);face.closePath()
      for(const side of [-1,1]) {
        const socket=new THREE.Path()
        socket.absellipse(side*.068,-.253,.049,.041,0,Math.PI*2,true,side*.14)
        face.holes.push(socket)
      }
      const nose=new THREE.Path();nose.moveTo(0,-.296);nose.lineTo(-.024,-.353);nose.quadraticCurveTo(0,-.345,.024,-.353);nose.closePath();face.holes.push(nose)
      const plate=new THREE.ExtrudeGeometry(face,{depth:.018,bevelEnabled:true,bevelSize:.008,bevelThickness:.01,bevelSegments:2,curveSegments:12})
      add(plate,ivory,[0,0,.087],lantern)
      ellipsoid([0,-.265,.043],[.127,.116,.022],dark,lantern)
      for(const side of [-1,1])tube([[side*.135,-.28,.075],[side*.154,-.31,.065],[side*.1,-.36,.11]],.012,ivory,lantern)
      tube([[-.107,-.352,.025],[-.095,-.437,.075],[0,-.455,.115],[.095,-.437,.075],[.107,-.352,.025]],.017,ivory,lantern)
      for(let i=0;i<8;i++) {
        const x=(i-3.5)*.019,z=.116-Math.abs(x)*.23
        const tooth=add(new THREE.BoxGeometry(.016,.024-(i%3)*.002,.02),ivory,[x,-.407,z],lantern)
        tooth.rotation.y=-x*2
      }
      const stain=standard('#5f5a4b',1)
      tube([[-.019,-.107,.116],[-.027,-.135,.115],[-.016,-.153,.116],[-.03,-.175,.116]],.0013,stain,lantern)
      tube([[.104,-.32,.117],[.087,-.339,.117],[.092,-.35,.116]],.0012,stain,lantern)
      add(new THREE.CylinderGeometry(.031,.038,.09,12),wax,[.015,-.065,-.02],lantern)
      const candle=new THREE.MeshBasicMaterial({color:'#ffd299',transparent:true,opacity:0,toneMapped:false});materials.push(candle)
      ellipsoid([.015,.006,-.02],[.014,.032,.014],candle,lantern)
      for(let i=0;i<3;i++)ellipsoid([.015+(i-1)*.022,-.1-i%2*.015,.005],[.009,.024,.009],wax,lantern)
      tube([[-.16,-.24,-.04],[-.14,-.055,-.04],[0,.035,0],[.14,-.055,-.04],[.16,-.24,-.04]],.01,iron,lantern)
      lantern.scale.x=.88
    } else {
      // A round witch's cauldron, carried by its bail, with rising potion bubbles.
      const cauldron=standard('#252b29',.84);cauldron.metalness=.58
      const kettle=new THREE.LatheGeometry(new THREE.SplineCurve([
        new THREE.Vector2(0,-.55),new THREE.Vector2(.14,-.54),new THREE.Vector2(.23,-.43),
        new THREE.Vector2(.235,-.34),new THREE.Vector2(.19,-.24),
      ]).getPoints(24),32)
      add(kettle,cauldron,[0,0,0],lantern)
      const lip=add(new THREE.TorusGeometry(.19,.023,8,32),iron,[0,-.24,0],lantern);lip.rotation.x=Math.PI/2
      const brew=standard('#592265',.28);brew.emissive.set('#ba51d4');brew.emissiveIntensity=1.1
      const surface=add(new THREE.CircleGeometry(.175,32),brew,[0,-.245,0],lantern);surface.rotation.x=-Math.PI/2
      for(let i=0;i<3;i++) {
        const a=i/3*Math.PI*2
        ellipsoid([Math.sin(a)*.15,-.55,Math.cos(a)*.15],[.03,.055,.03],iron,lantern)
      }
      tube([[-.22,-.32,0],[-.19,-.08,0],[0,.035,0],[.19,-.08,0],[.22,-.32,0]],.014,iron,lantern)
      for(let i=0;i<5;i++) {
        const bubble=add(new THREE.SphereGeometry(.025+i%2*.009,12,8),brew,[Math.sin(i*2.4)*.1,-.22,Math.cos(i*2.4)*.1],lantern)
        bubbles.push(bubble)
      }
    }
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2;ribbon([[Math.sin(a)*.36,.6,Math.cos(a)*.24],[Math.sin(a)*.48,.25,Math.cos(a)*.3],[Math.sin(a)*.55,-.05,Math.cos(a)*.33]],.11,a)}
  }
  const light = new THREE.PointLight(variant === 'fixer' ? '#ffac55' : variant === 'analyst' ? '#ffd09c' : accent,0,options.lightDistance ?? 4,2)
  light.position.set(-.67,variant === 'analyst' ? 1.49 : variant === 'fixer' ? 1.06 : .95,.6);body.add(light)
  const rim = new THREE.PointLight('#a6c2d4',0,5,2)
  rim.position.set(.45,2.05,-.65);body.add(rim)
  // Soft particles share one texture; no new allocations or geometry edits during animation.
  const size=32,data=new Uint8Array(size*size*4)
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const r=Math.hypot((x-15.5)/15.5,(y-15.5)/15.5);data.set([255,255,255,Math.round(Math.max(0,1-r)**3*255)],(y*size+x)*4)}
  const moteMap=new THREE.DataTexture(data,size,size);moteMap.needsUpdate=true;textures.push(moteMap)
  const pg=new THREE.BufferGeometry(),points=new Float32Array(96*3)
  for(let i=0;i<96;i++)points.set([Math.sin(i*2.4)*(.35+i%9*.05),i%23/23*1.2,Math.cos(i*2.4)*.35],i*3)
  pg.setAttribute('position',new THREE.BufferAttribute(points,3))
  const pm=new THREE.PointsMaterial({map:moteMap,color:accent,size:.045,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending});materials.push(pm)
  const motes=new THREE.Points(pg,pm);body.add(motes)
  // A single soft particle batch curls around each dissolving hem.
  const fogSize=128, fogData=new Uint8Array(fogSize*fogSize*4)
  for(let y=0;y<fogSize;y++)for(let x=0;x<fogSize;x++) {
    const u=(x-63.5)/63.5,v=(y-63.5)/63.5,r=Math.hypot(u,v)
    const curl=.5+.22*Math.sin(u*13+Math.sin(v*9)*2)+.14*Math.sin(v*21+u*8)
    const alpha=Math.max(0,1-r)**2*curl
    fogData.set([255,255,255,Math.round(alpha*255)],(y*fogSize+x)*4)
  }
  const fogMap=new THREE.DataTexture(fogData,fogSize,fogSize);fogMap.needsUpdate=true;fogMap.magFilter=THREE.LinearFilter;textures.push(fogMap)
  const fogGeometry=new THREE.BufferGeometry(),fogPositions=new Float32Array(22*3)
  for(let i=0;i<22;i++)fogPositions.set([Math.sin(i*2.4)*(.18+i%5*.07),-.08+i%7*.065,Math.cos(i*2.4)*.25],i*3)
  fogGeometry.setAttribute('position',new THREE.BufferAttribute(fogPositions,3))
  const fogMaterial=new THREE.PointsMaterial({map:fogMap,color:'#849ca8',size:.78,transparent:true,opacity:0,depthWrite:false})
  fogMaterial.onBeforeCompile=shader=>{
    shader.uniforms.soulTime=timeUniform
    shader.vertexShader='uniform float soulTime;\n'+shader.vertexShader
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`
      #include <begin_vertex>
      transformed.x += sin(soulTime * .43 + position.y * 12.0) * .13;
      transformed.y += sin(soulTime * .37 + position.x * 7.0) * .09;
      transformed.z += cos(soulTime * .31 + position.y * 9.0) * .1;
    `)
  }
  fogMaterial.customProgramCacheKey=()=> 'soul-hem-mist-v1'
  materials.push(fogMaterial)
  const hemMist=new THREE.Points(fogGeometry,fogMaterial);hemMist.frustumCulled=false;body.add(hemMist)
  batchStaticMeshes(lantern,new Set(bubbles));batchStaticMeshes(body,new Set([lantern]))
  let timeline=0,elapsed=0,motionTime=0,previousTime:number|undefined
  const set=(T:number,time:number,_pose=1,fade=1,_local=-1)=>{
    timeline=T;elapsed=time;motionTime+=Math.min(.05,Math.max(0,time-(previousTime??time)));previousTime=time
    timeUniform.value=motionTime
    const appear=smooth((T-4.8)/4.5)*THREE.MathUtils.clamp(fade,0,1)
    materials.forEach(m=>m.opacity=appear*(m === pm ? 0.3 : m === fogMaterial ? .24 : 1))
    light.intensity=appear*(variant === 'analyst'?.55:variant === 'tester'?1.8:3.8*(.94+Math.sin(motionTime*13)*.04+Math.sin(motionTime*21)*.02))*(options.lightIntensity??1)
    rim.intensity=appear*1.4
    body.position.y=Math.sin(motionTime*.75)*.045-(1-appear)*.15
    body.rotation.z=Math.sin(motionTime*.5)*.012
    lantern.rotation.z=Math.sin(motionTime*1.3)*.06
    bubbles.forEach((bubble,i)=>{
      const rise=(motionTime*.27+i*.2)%1
      bubble.position.y=-.23+rise*.26
      bubble.scale.setScalar(Math.sin(rise*Math.PI)*.9)
    })
    motes.rotation.y=motionTime*.12
    root.visible=appear>.003
    return appear
  }
  return {group:root,set,update(dt:number){return set(timeline+dt,elapsed+dt)},setPixelRatio(_ratio:number){},dispose(){const geometries=new Set<THREE.BufferGeometry>();root.traverse(node=>{const g=(node as THREE.Mesh).geometry;if(g)geometries.add(g)});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());parent.remove(root)}}
}
