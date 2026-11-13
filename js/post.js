// 后期处理：泛光、速度感的径向模糊、暗角、色差、色调映射
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uBlur: { value: 0 },
    uVignette: { value: 0.22 },
    uAberr: { value: 0 },
    uDesat: { value: 0 },
    uTint: { value: new THREE.Vector3(0, 0, 0) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uBlur, uVignette, uAberr, uDesat;
    uniform vec2 uCenter;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main(){
      vec2 dir = vUv - uCenter;
      float dist = length(dir);
      vec3 col;
      if (uBlur > 0.002) {
        col = vec3(0.0);
        float tot = 0.0;
        for (int i = 0; i < 12; i++) {
          float t = float(i) / 11.0;
          float w = 1.0 - t * 0.55;
          col += texture2D(tDiffuse, vUv - dir * t * uBlur * dist * 1.5).rgb * w;
          tot += w;
        }
        col /= tot;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }
      if (uAberr > 0.0005) {
        col.r = mix(col.r, texture2D(tDiffuse, vUv - dir * uAberr * dist).r, 0.85);
        col.b = mix(col.b, texture2D(tDiffuse, vUv + dir * uAberr * dist).b, 0.85);
      }
      float v = smoothstep(0.3, 0.95, dist);
      col *= 1.0 - v * uVignette;
      float l = dot(col, vec3(0.3, 0.59, 0.11));
      col = mix(col, vec3(l), uDesat);
      col += uTint * v;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.75, 1.05);
    this.final = new ShaderPass(FinalShader);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.final);
    this.composer.addPass(this.output);
    this.u = this.final.uniforms;
  }
  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
  }
  setQuality(level) {
    this.bloom.enabled = level !== 'low';
  }
  // 设置和速度、G 力有关的画面效果
  setEffects({ blur = 0, vignette = 0.22, aberr = 0, desat = 0, tint = null }) {
    this.u.uBlur.value = blur;
    this.u.uVignette.value = vignette;
    this.u.uAberr.value = aberr;
    this.u.uDesat.value = desat;
    if (tint) this.u.uTint.value.set(tint[0], tint[1], tint[2]);
    else this.u.uTint.value.set(0, 0, 0);
  }
  render() {
    this.composer.render();
  }
}
