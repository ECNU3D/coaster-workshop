// 资源加载：贴图（assets/tex）和 Blender 导出的模型（assets/models）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TILE_TEXTURES = ['grass', 'rock', 'sand', 'snow', 'redrock', 'basalt', 'dirt', 'concrete', 'bark', 'planks', 'pavement', 'stonebrick', 'rooftile', 'dinoskin', 'scifi'];
const LEAF_TEXTURES = ['leaf_broad', 'leaf_pine', 'leaf_palm', 'leaf_fern', 'leaf_tropic'];
const PLAIN_TEXTURES = ['stainedglass', 'nebula'];

export const assets = {
  tex: {},      // 贴图。法线贴图的名字带 _n 后缀
  parts: {},    // 列车部件：{ 部件名: [{ key: 材质名, geo }] }
  nature: {},   // 树木岩石：同上，带贴图坐标
  props: {},    // 站台、游乐设施、城堡、恐龙等：同上，带贴图坐标
};

function collect(gltf, target) {
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const i = o.name.indexOf('__');
    if (i < 0) return;
    const part = o.name.slice(0, i), key = o.name.slice(i + 2).replace(/_\d+$/, '');
    const geo = o.geometry;
    geo.applyMatrix4(o.matrixWorld);
    (target[part] = target[part] || []).push({ key, geo });
  });
}

// 把树叶面片的法线改成从树冠中心向外，这样整棵树的明暗是连续的，不会一片亮一片暗
function softenLeafNormals(geo, mode) {
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (mode === 'cone') v.set(v.x, 0.55 * Math.hypot(v.x, v.z) + 0.3, v.z);
    else if (mode === 'up') v.set((v.x - c.x) * 0.35, 1.2, (v.z - c.z) * 0.35);
    else v.sub(c).setY(v.y + 0.35 * geo.boundingBox.getSize(new THREE.Vector3()).y * 0.5);
    v.normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  nor.needsUpdate = true;
}

export async function loadAssets(renderer, onProgress) {
  const texLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const jobs = [];
  let done = 0;
  const step = () => onProgress && onProgress(++done / jobs.length);
  const tex = (name, file, srgb, optional = false) => {
    jobs.push(texLoader.loadAsync('assets/tex/' + file).catch((err) => {
      if (optional) return null;
      throw err;
    }).then((t) => {
      step();
      if (!t) return;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, maxAniso);
      assets.tex[name] = t;
    }));
  };
  for (const n of TILE_TEXTURES) {
    tex(n, n + '.jpg', true);
    tex(n + '_n', n + '_n.jpg', false);
  }
  for (const n of LEAF_TEXTURES) tex(n, n + '.png', true);
  for (const n of PLAIN_TEXTURES) tex(n, n + '.jpg', true, true);
  jobs.push(gltfLoader.loadAsync('assets/models/parts.glb').then((g) => { collect(g, assets.parts); step(); }));
  jobs.push(gltfLoader.loadAsync('assets/models/nature.glb').then((g) => { collect(g, assets.nature); step(); }));
  jobs.push(gltfLoader.loadAsync('assets/models/props.glb').then((g) => { collect(g, assets.props); step(); }));
  await Promise.all(jobs);

  for (const n of [...LEAF_TEXTURES, ...PLAIN_TEXTURES]) {
    if (assets.tex[n]) assets.tex[n].wrapS = assets.tex[n].wrapT = THREE.ClampToEdgeWrapping;
  }
  // 阔叶树的每张面片上重复 2x2 簇树叶，叶子的大小更接近真实的树
  assets.tex.leaf_broad.wrapS = assets.tex.leaf_broad.wrapT = THREE.RepeatWrapping;
  assets.tex.leaf_broad.repeat.set(2, 2);
  const leaf = (name, mode) => {
    const p = (assets.nature[name] || []).find((x) => x.key.startsWith('leaf'));
    if (p) softenLeafNormals(p.geo, mode);
  };
  leaf('tree_broad', 'sphere');
  leaf('bush', 'sphere');
  leaf('tree_pine', 'cone');
  leaf('tree_palm', 'up');
  for (const name of ['fern', 'tropic']) {
    const p = (assets.props[name] || []).find((x) => x.key.startsWith('leaf'));
    if (p) softenLeafNormals(p.geo, 'up');
  }
  return assets;
}
