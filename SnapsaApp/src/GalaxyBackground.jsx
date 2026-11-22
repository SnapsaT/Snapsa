// src/GalaxyBackground.jsx — animated WebGL galaxy for every Snapsa header.
// Cheap on purpose: small canvas, ~30fps, pauses when hidden/off-screen, CSS fallback if WebGL is missing.
import React, { useEffect, useRef, useState } from 'react';

const VERT = `attribute vec2 a_position; varying vec2 v_uv;
void main(){ v_uv = a_position*0.5+0.5; gl_Position = vec4(a_position,0.0,1.0); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv; uniform float u_time; uniform vec2 u_resolution;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x), mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x), f.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; mat2 r=mat2(0.8,0.6,-0.6,0.8);
  for(int i=0;i<4;i++){ v+=a*noise(p); p=r*p*2.05; a*=0.5; } return v; }
vec3 starLayer(vec2 uv,float scale,float density,float seed){
  vec2 gv=fract(uv*scale)-0.5; vec2 id=floor(uv*scale)+seed; float n=hash(id);
  if(n>density) return vec3(0.0);
  vec2 off=vec2(hash(id+17.3),hash(id+91.7))-0.5; float d=length(gv-off*0.65);
  float tw=0.7+0.3*sin(u_time*2.5+n*40.0);
  float core=smoothstep(0.10,0.0,d)*tw; float halo=exp(-d*16.0)*0.5*tw;
  vec3 c=vec3(1.0);
  if(n<density*0.25) c=vec3(0.7,0.85,1.0); else if(n<density*0.5) c=vec3(1.0,0.8,0.9); else if(n<density*0.75) c=vec3(0.92,0.72,1.0);
  return c*(core+halo);
}
void main(){
  vec2 uv=(v_uv-0.5)*2.0; uv.x*=u_resolution.x/u_resolution.y;
  // wide header: stretch the galaxy so it reads at 7:1
  uv.x*=0.42;
  float r=length(uv), ang=atan(uv.y,uv.x);
  vec3 col=vec3(0.03,0.01,0.07);
  float sw=ang*2.0+r*6.5-u_time*0.35;
  float arm=pow(max(0.0,cos(sw)),3.0)*exp(-pow((r-0.38)/0.5,2.0));
  vec2 q=uv*2.2;
  float n1=pow(fbm(q+vec2(u_time*0.05,-u_time*0.03)),1.7);
  float n2=pow(fbm(q*1.4-vec2(2.4,1.1)+n1*0.6+vec2(-u_time*0.04,0.0)),2.0);
  float n3=pow(fbm(q*2.1+vec2(4.2,-3.5)),2.3);
  col+=vec3(0.70,0.10,0.62)*n1*1.25;   // magenta
  col+=vec3(0.36,0.14,0.85)*n2*1.2;    // violet
  col+=vec3(0.95,0.20,0.55)*n3*0.4;    // hot pink dust
  col+=vec3(0.65,0.40,0.95)*arm*0.9;
  vec2 su=v_uv; su.x*=u_resolution.x/u_resolution.y;
  col+=starLayer(su+vec2(u_time*0.012,0.0),22.0,0.14,1.0);
  col+=starLayer(su-vec2(u_time*0.007,0.0),40.0,0.18,12.0)*0.75;
  col+=starLayer(su,70.0,0.22,37.0)*0.5;
  col*=0.5;
  gl_FragColor=vec4(col,1.0);
}`;

const FALLBACK = {
  background: 'linear-gradient(120deg,#2b0f52,#7a1d9c,#ff2d95,#4a1aa8,#2b0f52)',
  backgroundSize: '300% 300%',
  animation: 'snapsaGalaxyFallback 9s ease-in-out infinite',
};

export const GalaxyBackground = ({ speed = 1, fps = 30, scale = 0.6, style, className }) => {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }); } catch {}
    if (!gl) { setFailed(true); return; }

    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setFailed(true); return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFailed(true); return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const tLoc = gl.getUniformLocation(prog, 'u_time'), rLoc = gl.getUniformLocation(prog, 'u_resolution');

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(2, Math.floor(r.width * scale)), h = Math.max(2, Math.floor(r.height * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    };
    resize();
    let ro = null;
    try { ro = new ResizeObserver(resize); ro.observe(canvas); } catch {}

    let raf = 0, last = 0, visible = true, onScreen = true, lost = false;
    const t0 = performance.now(), gap = 1000 / fps;
    const frame = (now) => {
      raf = 0;
      if (!visible || !onScreen || lost) return;
      if (now - last >= gap) {
        last = now;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(tLoc, (((now - t0) / 1000) * speed) % 600);
        gl.uniform2f(rLoc, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf && visible && onScreen && !lost) raf = requestAnimationFrame(frame); };
    const onVis = () => { visible = !document.hidden; kick(); };
    document.addEventListener('visibilitychange', onVis);
    let io = null;
    try { io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; kick(); }); io.observe(canvas); } catch {}
    const onLost = (e) => { e.preventDefault(); lost = true; };
    const onRestored = () => { setFailed(true); }; // simplest safe path: fall back to CSS gradient
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    kick();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      try { ro?.disconnect(); io?.disconnect(); } catch {}
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    };
  }, [speed, fps, scale]);

  return (
    <>
      <style>{`@keyframes snapsaGalaxyFallback{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}`}</style>
      {failed
        ? <div className={className} style={{ width: '100%', height: '100%', ...FALLBACK, ...style }} />
        : <canvas ref={ref} className={className} style={{ display: 'block', width: '100%', height: '100%', ...style }} />}
    </>
  );
};

export default GalaxyBackground;
