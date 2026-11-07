/* Shared helper: POST JSON to the Sailo API. Resolves with the parsed body or throws with the server's message. */
window.sailoPost=function(url,data){
  return fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(data||{})})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){if(!r.ok)throw new Error(b.error||'Something went wrong. Please try again.');return b})});
};
window.ACCESS_EMAIL='hello@pdyntech.com';

/* Numbers calculator */
(function(){
  var faces=[750000,1000000,1500000],sel=0;
  var fmt=function(n){return '₱'+n.toLocaleString('en-US')};
  var pw=document.getElementById('presets');
  function render(){
    var V=faces[sel],adv=Math.floor(V*85/100),yld=Math.floor(V*3/100),lp=adv+yld,fee=Math.floor(V*5/1000),reb=V-lp-fee;
    var rows=[['Advance to shipowner',adv,'#0B3D3B'],['Repaid to investor',lp,'#4DD0E1'],['Rebate to shipowner',reb,'#F57C00'],['Protocol fee',fee,'#1F2937']];
    document.getElementById('face').textContent=fmt(V);
    document.getElementById('rows').innerHTML=rows.map(function(r){
      return '<div class="row"><div><span>'+r[0]+'</span><b>'+fmt(r[1])+'</b></div><div class="bar"><i style="width:'+(r[1]/V*100).toFixed(1)+'%;background:'+r[2]+'"></i></div></div>';
    }).join('');
    document.getElementById('sum').textContent=fmt(lp+reb+fee)+' = '+fmt(V);
    document.getElementById('ret').textContent='Investor: '+fmt(adv)+' in, '+fmt(lp)+' back. '+(yld/adv*100).toFixed(2)+'% in 60 days.';
    pw.innerHTML='';
    faces.forEach(function(f,k){
      var b=document.createElement('button');b.textContent=fmt(f);b.setAttribute('aria-pressed',k===sel);
      b.onclick=function(){sel=k;render()};pw.appendChild(b);
    });
  }
  render();
  var c=document.getElementById('count');
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
    var t0=null;c.textContent='₱0';
    setTimeout(function(){requestAnimationFrame(function step(t){
      if(!t0)t0=t;var p=Math.min((t-t0)/1800,1),e=1-Math.pow(1-p,3);
      c.textContent=fmt(Math.round(850000*e));
      if(p<1)requestAnimationFrame(step);
    })},700);
  }
})();

/* Hero reveal, 3D "how it works" scene */
(function(){
var how=document.getElementById('how'),cv=document.getElementById('gl');
var steps=[].slice.call(how.querySelectorAll('.steps li'));
var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(window.lucide)lucide.createIcons();
function glOK(){try{var c=document.createElement('canvas');return !!(window.THREE&&window.gsap&&window.ScrollTrigger&&(c.getContext('webgl')||c.getContext('experimental-webgl')))}catch(e){return false}}
function reveals(){
  gsap.registerPlugin(ScrollTrigger);
  gsap.to('.hero>img',{yPercent:9,ease:'none',scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub:true}});
  gsap.from('.wait',{width:0,ease:'none',scrollTrigger:{trigger:'.race',start:'top 85%',end:'bottom 60%',scrub:true}});
  gsap.from('.got',{width:0,duration:1.2,ease:'power3.out',scrollTrigger:{trigger:'.race',start:'top 70%'}});
  var els='.cost,.person,.stack>div,.limits li,.guards li,.ledger';
  gsap.set(els,{opacity:0,y:36});
  ScrollTrigger.batch(els,{start:'top 92%',once:true,onEnter:function(b){gsap.to(b,{opacity:1,y:0,duration:.8,stagger:.1,ease:'power3.out',overwrite:true})}});
}
function scene(){
  var R=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true});
  R.setPixelRatio(Math.min(devicePixelRatio,2));
  var S=new THREE.Scene();S.fog=new THREE.Fog(0x0B3D3B,14,40);
  var cam=new THREE.PerspectiveCamera(55,1,.1,100),look=new THREE.Vector3(-3,1,0);
  cam.position.set(-2,5.5,17);
  S.add(new THREE.HemisphereLight(0xcdeeed,0x0b3d3b,.95));
  var sun=new THREE.DirectionalLight(0xffb066,1.15);sun.position.set(-6,10,8);S.add(sun);
  var M=function(c,o){return new THREE.MeshStandardMaterial(Object.assign({color:c,flatShading:true,roughness:.7},o||{}))};
  var box=function(w,h,d,c){return new THREE.Mesh(new THREE.BoxGeometry(w,h,d),M(c))};
  var sg=new THREE.PlaneGeometry(240,150,96,60);sg.rotateX(-Math.PI/2);
  var sea=new THREE.Mesh(sg,M(0x14504D,{roughness:.9}));sea.position.y=-.25;S.add(sea);
  var pos=sg.attributes.position,base=pos.array.slice();
  var dock=box(7,.7,9,0x24504D);dock.position.set(11.5,-.05,0);S.add(dock);
  [[-.8],[.8]].forEach(function(z){var l=box(.35,4.4,.35,0xF57C00);l.position.set(12.8,2.5,z[0]);S.add(l)});
  var top=box(.5,.35,2,0xF57C00);top.position.set(12.8,4.7,0);S.add(top);
  var boom=box(6,.3,.4,0xF57C00);boom.position.set(9.8,4.7,0);S.add(boom);
  var ship=new THREE.Group();ship.position.set(-9,0,0);S.add(ship);
  var hull=box(7,.9,2,0xF2EEE4);hull.position.y=.25;ship.add(hull);
  var band=box(7.04,.28,2.04,0xF57C00);band.position.y=-.05;ship.add(band);
  var br=box(1.1,1.7,1.8,0xFAF7F0);br.position.set(-2.7,1.5,0);ship.add(br);
  var fn=box(.5,.7,.5,0x1F2937);fn.position.set(-2.7,2.7,0);ship.add(fn);
  var cols=[0xF57C00,0x4DD0E1,0xFAF7F0,0x1F2937],cons=[],edges=[];
  for(var i=0;i<4;i++)for(var j=0;j<2;j++)for(var k=0;k<2;k++){
    var c=box(1,.6,.85,cols[(i+j+k)%4]);c.position.set(i*1.1-.4,.7+j*.62,k?.5:-.5);c.scale.setScalar(.001);
    var em=new THREE.LineBasicMaterial({color:0x4DD0E1,transparent:true,opacity:0});
    var e=new THREE.LineSegments(new THREE.EdgesGeometry(c.geometry),em);e.scale.setScalar(1.03);c.add(e);
    ship.add(c);cons.push(c);edges.push(em);
  }
  function coin(col){var g=new THREE.Group(),m=new THREE.Mesh(new THREE.CylinderGeometry(.6,.6,.14,28),M(col,{emissive:col,emissiveIntensity:.35,flatShading:false,metalness:.3}));m.rotation.x=Math.PI/2;g.add(m);g.scale.setScalar(.001);return g}
  var c1=coin(0xF57C00);c1.position.set(0,9,0);ship.add(c1);
  var c2=coin(0x4DD0E1);c2.position.set(9.2,10,0);S.add(c2);
  function ring(r,col,p,x,y){var m=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0}),t=new THREE.Mesh(new THREE.TorusGeometry(r,.05,8,72),m);t.rotation.x=Math.PI/2;t.position.set(x,y,0);p.add(t);return t}
  var ping=ring(1,0x4DD0E1,ship,0,.3),esc=ring(2.3,0x4DD0E1,S,10.5,.5);
  var tl=gsap.timeline({defaults:{ease:'power2.inOut'},scrollTrigger:{trigger:how,start:'top top',end:'bottom bottom',scrub:.8,onUpdate:function(s){mark(Math.min(5,Math.floor(s.progress*6)))}}});
  /* 1 tokenize */
  tl.to(cam.position,{x:-7,y:3.6,z:10.5,duration:1},0).to(look,{x:-8.5,y:1.2,duration:1},0)
    .to(cons.map(function(c){return c.scale}),{x:1,y:1,z:1,stagger:.04,duration:.4,ease:'back.out(2)'},.1)
    .to(edges,{opacity:.95,duration:.4},.6)
  /* 2 fund */
    .to(c1.scale,{x:1,y:1,z:1,duration:.1,ease:'none'},1.05)
    .to(c1.position,{y:2.1,duration:.8,ease:'bounce.out'},1.05).to(c1.rotation,{y:Math.PI*4,duration:.8},1.05)
    .to(esc.material,{opacity:.7,duration:.3},1.5)
    .to(cam.position,{x:-8,y:5,z:9.5,duration:1},1).to(look,{x:-9,y:1.2,duration:1},1)
  /* 3 advance */
    .fromTo(ping.scale,{x:1,y:1,z:1},{x:6,y:6,z:6,duration:.9,immediateRender:false},2)
    .fromTo(ping.material,{opacity:.9},{opacity:0,duration:.9,immediateRender:false},2)
    .to(ship.position,{x:4,duration:1.9},2.1)
    .to(cam.position,{x:1,y:4.2,z:12,duration:2},2).to(look,{x:3,y:1,duration:2},2)
  /* 4 berth */
    .fromTo(ping.scale,{x:1,y:1,z:1},{x:6,y:6,z:6,duration:.9,immediateRender:false},3.7)
    .fromTo(ping.material,{opacity:.9},{opacity:0,duration:.9,immediateRender:false},3.7)
  /* 5 pay */
    .to(cam.position,{x:6,y:3.5,z:10,duration:1},4).to(look,{x:8,y:1.2,duration:1},4)
    .to(c2.scale,{x:1,y:1,z:1,duration:.1,ease:'none'},4.1)
    .to(c2.position,{y:1.1,duration:.8,ease:'bounce.out'},4.1).to(c2.rotation,{y:Math.PI*4,duration:.8},4.1)
  /* 6 settle */
    .to(edges.map(function(m){return m.color}),{r:.96,g:.49,b:0,duration:.5},5)
    .to([c1.position,c2.position],{y:'+=3',duration:.8},5).to([c1.scale,c2.scale],{x:.001,y:.001,z:.001,duration:.8},5.1)
    .to(esc.scale,{x:.01,y:.01,z:.01,duration:.8},5)
    .to(cam.position,{x:3,y:7,z:19,duration:1},5).to(look,{x:5,y:1,duration:1},5);
  var num=document.getElementById('how-n');
  function mark(n){steps.forEach(function(s,i){s.classList.toggle('on',i===n)});how.style.setProperty('--step',n+1);if(num)num.textContent=n+1}
  mark(0);
  function size(){var w=cv.clientWidth,h=cv.clientHeight;if(!w||!h)return;R.setSize(w,h,false);cam.aspect=w/h;cam.fov=w/h<.8?72:55;
    /* The canvas spans the whole section; on wide screens shift the view right so the ship sits beside the glass panel. */
    var dx=matchMedia('(min-width:861px)').matches?how.querySelector('.how-copy').offsetWidth/2:0;
    if(dx)cam.setViewOffset(w,h,-dx,0,w,h);else cam.clearViewOffset();cam.updateProjectionMatrix()}
  size();new ResizeObserver(size).observe(cv);
  var vis=true;ScrollTrigger.create({trigger:how,start:'top bottom',end:'bottom top',onToggle:function(s){vis=s.isActive}});
  gsap.ticker.add(function(t){
    if(!vis)return;
    for(var i=0;i<pos.count;i++){var x=base[i*3],z=base[i*3+2];pos.setY(i,Math.sin(x*.5+t*1.1)*.14+Math.cos(z*.6+t*.8)*.1)}
    pos.needsUpdate=true;
    ship.position.y=Math.sin(t*1.2)*.06;ship.rotation.z=Math.sin(t*.9)*.015;
    cam.lookAt(look);R.render(S,cam);
  });
}
if(window.gsap&&window.ScrollTrigger&&!reduce)reveals();
function fallback(){if(window.ScrollTrigger)ScrollTrigger.getAll().filter(function(t){return t.trigger===how}).forEach(function(t){t.kill()});how.classList.add('static');steps.forEach(function(s){s.classList.add('on')})}
try{if(glOK()&&!reduce)scene();else fallback()}catch(err){console.error('Sailo 3D scene failed:',err);fallback()}
})();

/* Enquiry form: saved on the server. If the server can't be reached, offer email instead. */
(function(){
var f=document.getElementById('access-form');if(!f)return;
f.addEventListener('submit',function(e){
  e.preventDefault();if(!f.reportValidity())return;
  var d=new FormData(f),n=document.getElementById('form-note'),btn=f.querySelector('button[type=submit]');
  var data={name:d.get('name'),company:d.get('company'),role:d.get('role'),email:d.get('email'),msg:d.get('msg')};
  btn.disabled=true;n.textContent='Sending…';
  sailoPost('/api/enquiry',data).then(function(){
    f.reset();n.textContent='Thanks, we’ve got your enquiry. We’ll reply to '+data.email+' with next steps.';
  }).catch(function(err){
    var body='Name: '+data.name+'\nCompany: '+data.company+'\nRole: '+data.role+'\nEmail: '+data.email+'\n\n'+data.msg;
    var url='mailto:'+ACCESS_EMAIL+'?subject='+encodeURIComponent('Sailo enquiry: '+data.role)+'&body='+encodeURIComponent(body);
    n.textContent=err.message+' ';
    var a=document.createElement('a');a.href=url;a.textContent='Send it by email instead';n.appendChild(a);
  }).then(function(){btn.disabled=false});
});
})();

/* Nav background on scroll */
(function(){var n=document.querySelector('.nav'),t=document.querySelector('.hero h1');if(!n||!t)return;
var tick=false;
function upd(){tick=false;n.classList.toggle('scrolled',scrollY>40);n.classList.toggle('brand',t.getBoundingClientRect().bottom<110)}
function req(){if(!tick){tick=true;requestAnimationFrame(upd)}}
addEventListener('scroll',req,{passive:true});addEventListener('resize',req);addEventListener('load',upd);upd();
})();

/* Newsletter signup: saved on the server. */
(function(){var f=document.getElementById('loop');if(!f)return;
f.addEventListener('submit',function(e){e.preventDefault();if(!f.reportValidity())return;
  var n=document.getElementById('loop-note'),btn=f.querySelector('button');btn.disabled=true;
  sailoPost('/api/subscribe',{email:f.email.value}).then(function(){f.reset();n.textContent='You’re on the list. We’ll send Sailo updates to your inbox.'})
  .catch(function(err){n.textContent=err.message}).then(function(){btn.disabled=false});
});
})();

/* Footer reveal */
(function(){var ft=document.querySelector('.site-foot'),pg=document.querySelector('.page'),r=document.documentElement;if(!ft||!pg)return;
function fit(){var h=ft.offsetHeight,ok=h<innerHeight*.85;r.classList.toggle('reveal',ok);pg.style.marginBottom=ok?h+'px':''}
fit();addEventListener('resize',fit);addEventListener('load',fit);
if(window.ResizeObserver)new ResizeObserver(fit).observe(ft);
})();

/* Mobile and tablet menu: the section links collapse behind a button below 1000px. */
(function(){
var n=document.querySelector('.nav'),b=n&&n.querySelector('.menu-btn'),links=document.getElementById('nav-links');if(!b||!links)return;
function set(open){n.classList.toggle('open',open);b.setAttribute('aria-expanded',open);b.setAttribute('aria-label',open?'Close menu':'Open menu');
  b.innerHTML='<i data-lucide="'+(open?'x':'menu')+'" class="i"></i>';if(window.lucide)lucide.createIcons();}
b.addEventListener('click',function(e){e.stopPropagation();set(!n.classList.contains('open'))});
links.addEventListener('click',function(e){if(e.target.closest('a'))set(false)});
document.addEventListener('click',function(e){if(n.classList.contains('open')&&!n.contains(e.target))set(false)});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&n.classList.contains('open')){set(false);b.focus()}});
matchMedia('(min-width:1001px)').addEventListener('change',function(m){if(m.matches)set(false)});
})();
