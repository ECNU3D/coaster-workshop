# 把生图工具生成的原图处理成游戏里用的贴图：
#   1. 地面类贴图做成可以无缝平铺的，并从明暗推算出法线贴图
#   2. 用木纹合成木板贴图，用混凝土合成地砖贴图
#   3. 树叶的洋红色背景抠成透明
# 用法：python tools/process_textures.py <原图目录> <输出目录>
import sys, os
import numpy as np
from PIL import Image
from scipy import ndimage

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SIZE = 1024


def load(name):
    im = Image.open(os.path.join(SRC, name + '.png')).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def smooth01(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def seamless(a, band=0.14):
    """先处理左右接缝，再处理上下接缝。每一步都把图和它平移半幅的副本在边缘处混合。"""
    n = a.shape[0]
    t = np.arange(n) / n
    w = smooth01((0.5 - np.abs(t - 0.5)) / band)  # 边缘是 0，中间是 1
    out = a
    for axis in (1, 0):
        shifted = np.roll(out, n // 2, axis=axis)
        m = w[None, :, None] if axis == 1 else w[:, None, None]
        out = out * m + shifted * (1 - m)
    return out


def normal_map(a, strength, extra_height=None):
    h = a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11
    if extra_height is not None:
        h = h * 0.5 + extra_height
    h = ndimage.gaussian_filter(h, 1.1, mode='wrap')
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    nz = np.ones_like(h) * 0.25
    n = np.stack([-dx, dy, nz], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def save_rgb(a, name, quality=90):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, name + '.jpg'), quality=quality)


TILES = {'grass': 3.0, 'rock': 5.0, 'sand': 2.5, 'snow': 2.2, 'redrock': 4.0, 'basalt': 6.0, 'dirt': 4.0, 'concrete': 1.5, 'bark': 6.0,
         'stonebrick': 5.0, 'rooftile': 5.0, 'dinoskin': 5.0, 'scifi': 3.0}
# 有规则图案的贴图，接缝处只做很窄的混合，免得图案重影
NARROW = {'stonebrick', 'rooftile', 'scifi'}
cache = {}
for name, k in TILES.items():
    if not os.path.exists(os.path.join(SRC, name + '.png')):
        print('missing', name)
        continue
    a = seamless(load(name), 0.05 if name in NARROW else 0.14)
    cache[name] = a
    save_rgb(a, name)
    save_rgb(normal_map(a, k), name + '_n', 92)
    print('tile', name)

# 木板：把竖向的木纹切成 6 条木板，每条错开一段并稍微改变明暗，中间留出缝
if os.path.exists(os.path.join(SRC, 'woodgrain.png')):
    g = seamless(load('woodgrain'))
    rng = np.random.default_rng(5)
    planks = np.zeros_like(g)
    height = np.zeros((SIZE, SIZE), np.float32)
    n = 6
    edges = np.linspace(0, SIZE, n + 1).astype(int)
    for i in range(n):
        x0, x1 = edges[i], edges[i + 1]
        src_x = int(rng.integers(0, SIZE - (x1 - x0)))
        strip = np.roll(g[:, src_x:src_x + (x1 - x0)], int(rng.integers(0, SIZE)), axis=0)
        planks[:, x0:x1] = strip * (0.85 + 0.3 * rng.random())
        xs = np.arange(x1 - x0)
        d = np.minimum(xs, (x1 - x0 - 1) - xs)
        gap = smooth01(d / 5.0)
        planks[:, x0:x1] *= (0.25 + 0.75 * gap)[None, :, None]
        height[:, x0:x1] = gap[None, :] * 0.5
    save_rgb(planks, 'planks')
    save_rgb(normal_map(planks, 4.0, height), 'planks_n', 92)
    print('planks')

# 地砖：在混凝土上画出 2x2 的大块地砖和砖缝
if 'concrete' in cache:
    c = cache['concrete'].copy()
    rng = np.random.default_rng(9)
    height = np.zeros((SIZE, SIZE), np.float32)
    n = 2
    step = SIZE // n
    ax = np.arange(SIZE) % step
    d = np.minimum(ax, step - 1 - ax)
    gx = smooth01(d / 6.0)
    grout = np.minimum(gx[None, :], gx[:, None])
    for i in range(n):
        for j in range(n):
            c[i * step:(i + 1) * step, j * step:(j + 1) * step] *= 0.86 + 0.24 * rng.random()
    c *= (0.45 + 0.55 * grout)[..., None]
    save_rgb(c, 'pavement')
    save_rgb(normal_map(c, 2.0, grout * 0.5), 'pavement_n', 92)
    print('pavement')

# 树叶：把洋红色背景抠掉，边缘去掉溢色，再把透明区域填上附近叶子的颜色，缩小后边缘不会发黑发紫
for name in ('leaf_broad', 'leaf_pine', 'leaf_palm', 'leaf_fern', 'leaf_tropic'):
    if not os.path.exists(os.path.join(SRC, name + '.png')):
        print('missing', name)
        continue
    a = load(name)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    key = np.minimum(r, b) - g  # 洋红色时这个值很大
    alpha = 1 - smooth01((key - 0.08) / 0.3)
    spill = b > g
    b2 = np.where(spill, g * 0.9, b)
    r2 = np.where(spill, np.minimum(r, g), r)
    rgb = np.stack([r2, g, b2], -1)
    solid = alpha > 0.6
    idx = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    filled = rgb[idx[0], idx[1]]
    rgb = np.where(solid[..., None], rgb, filled)
    alpha = ndimage.gaussian_filter(alpha, 0.6)
    rgba = np.concatenate([rgb, alpha[..., None]], -1)
    Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(OUT, name + '.png'), optimize=True)
    print('leaf', name, 'coverage %.2f' % float(solid.mean()))

# 彩色玻璃窗和星云：只需要缩放
for name in ('stainedglass', 'nebula'):
    if os.path.exists(os.path.join(SRC, name + '.png')):
        save_rgb(load(name), name)
        print('plain', name)

total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print('done, total %.1f MB' % (total / 1048576))
