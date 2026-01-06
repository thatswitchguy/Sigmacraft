export function initGame(THREE){
  let blockTypes = {};
  let blockMaterials = {};
  const blocks3D = [];

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff,0.4));
  const sun = new THREE.DirectionalLight(0xffffff,0.8);
  sun.position.set(50,100,50);
  scene.add(sun);

  const player = { group: new THREE.Group(), velocity: new THREE.Vector3(), onGround:false, yaw:0, pitch:0 };
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.8,0.8,0.8), new THREE.MeshStandardMaterial({color:0xffcc99}));
  head.position.y = 1.6;
  player.group.add(head);
  camera.position.set(0,1.6,0);
  head.add(camera);
  scene.add(player.group);

  const keys = {};
  window.addEventListener("keydown", e => keys[e.code]=true);
  window.addEventListener("keyup", e => keys[e.code]=false);
  renderer.domElement.addEventListener("click", ()=>renderer.domElement.requestPointerLock());
  document.addEventListener("mousemove", e=>{
    if(document.pointerLockElement!==renderer.domElement) return;
    player.yaw -= e.movementX*0.002;
    player.pitch -= e.movementY*0.002;
    player.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2,player.pitch));
  });

  async function loadBlocks(){
    const res = await fetch("/textures");
    blockTypes = await res.json();
    for(const name in blockTypes){
      const tex = blockTypes[name].textures;
      blockMaterials[name] = [
        new THREE.MeshStandardMaterial({ color: tex.right }),
        new THREE.MeshStandardMaterial({ color: tex.left }),
        new THREE.MeshStandardMaterial({ color: tex.top }),
        new THREE.MeshStandardMaterial({ color: tex.bottom }),
        new THREE.MeshStandardMaterial({ color: tex.front }),
        new THREE.MeshStandardMaterial({ color: tex.back })
      ];
      const sel = document.getElementById("blockSelect");
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  }

  // DEV MODE
  window.addEventListener("keydown", e=>{
    if(e.key==">"){
      const pw = prompt("Enter dev password:");
      if(pw==="thatswitchguy") document.getElementById("devOverlay").style.display="block";
    }
  });
  document.getElementById("closeDev").onclick = ()=>document.getElementById("devOverlay").style.display="none";
  document.getElementById("applyColor").onclick = async ()=>{
    const blockName = document.getElementById("blockSelect").value;
    const side = document.getElementById("sideSelect").value;
    const colorHex = document.getElementById("colorPicker").value;
    await fetch("/update-block",{
      method:"POST",
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({blockName,side,colorHex})
    });
    alert("Saved! Reload to see changes.");
  };

  // PHYSICS
  const GRAVITY=-0.03, SPEED=0.12, JUMP=0.6;
  function collide(pos){
    for(const b of blocks3D){
      if(Math.abs(pos.x-b.mesh.position.x)<0.6 &&
         Math.abs(pos.y-b.mesh.position.y)<1.7 &&
         Math.abs(pos.z-b.mesh.position.z)<0.6) return true;
    }
    return false;
  }

  // RAYCAST
  const raycaster = new THREE.Raycaster();
  window.addEventListener("mousedown", e=>{
    raycaster.setFromCamera({x:0,y:0},camera);
    const intersects = raycaster.intersectObjects(blocks3D.map(b=>b.mesh));
    if(intersects.length>0){
      const hit = intersects[0];
      if(e.button===0){
        const type = document.getElementById("blockSelect").value || "dirt";
        const mat = blockMaterials[type];
        const newBlock = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mat);
        const p = hit.point.clone().add(hit.face.normal);
        newBlock.position.set(Math.floor(p.x+0.5),Math.floor(p.y+0.5),Math.floor(p.z+0.5));
        scene.add(newBlock);
        blocks3D.push({mesh:newBlock,type,pos:{...newBlock.position}});
      } else if(e.button===2){
        const obj = hit.object;
        scene.remove(obj);
        const idx = blocks3D.findIndex(b=>b.mesh===obj);
        if(idx!==-1) blocks3D.splice(idx,1);
      }
    }
  });

  // ANIMATE
  function animate(){
    requestAnimationFrame(animate);

    player.group.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;

    const dir = new THREE.Vector3();
    if(keys["KeyW"]) dir.z-=1;
    if(keys["KeyS"]) dir.z+=1;
    if(keys["KeyA"]) dir.x-=1;
    if(keys["KeyD"]) dir.x+=1;
    
    if (dir.lengthSq() > 0) {
      dir.normalize().applyAxisAngle(new THREE.Vector3(0,1,0),player.yaw);
      player.group.position.addScaledVector(dir,SPEED);
    }

    player.velocity.y+=GRAVITY;
    const next=player.group.position.clone();
    next.y+=player.velocity.y;
    if(!collide(next)){player.group.position.y=next.y;player.onGround=false;}
    else{player.velocity.y=0;player.onGround=true;}
    if(keys["Space"] && player.onGround) player.velocity.y=JUMP;

    renderer.render(scene,camera);
  }

  loadBlocks().then(()=>animate());

  window.addEventListener("resize", ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
