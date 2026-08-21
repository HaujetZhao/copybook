<script setup>
import { ref, watch, watchEffect } from 'vue';

const themes = [
  { name: '暗夜', vars: { '--bg': '#1e1f24', '--canvas': '#26272c', '--text': '#e6e4e0', '--muted': '#8b8d94', '--accent': '#aeb9ff', '--border': '#33353c' } },
  { name: '宣纸', vars: { '--bg': '#e9e2d5', '--canvas': '#f5f0e6', '--text': '#3a332a', '--muted': '#9a8f7d', '--accent': '#b08347', '--border': '#d8cfbc' } },
  { name: '黛蓝', vars: { '--bg': '#171a21', '--canvas': '#1e222c', '--text': '#dfe3ec', '--muted': '#828a9b', '--accent': '#9db4f0', '--border': '#282c37' } },
];

// 持久化:主题/字号/可编辑状态存 localStorage,刷新后恢复
const saved = JSON.parse(localStorage.getItem('jxp') || '{}');
const editable = ref(saved.editable ?? true);
const size = ref(saved.size ?? 64);
const laserMode = ref(saved.laserMode ?? 'dot'); // 'dot' 点跟随 | 'trail' 荧光笔迹
const theme = ref(themes.find(t => t.name === saved.theme) ?? themes[0]);

// 限制最大宽度后,页面外的 body 露出区域也要跟主题同色
watchEffect(() => {
  document.body.style.background = theme.value.vars['--bg'];
});

// 预览态全页禁选中/禁长按呼出菜单,防止临摹时误选画布外文字
watchEffect(() => {
  document.body.style.userSelect = editable.value ? '' : 'none';
  document.body.style.webkitUserSelect = editable.value ? '' : 'none';
  document.body.style.webkitTouchCallout = editable.value ? '' : 'none';
});

watch([editable, size, theme], () => {
  localStorage.setItem('jxp', JSON.stringify({
    editable: editable.value, size: size.value, laserMode: laserMode.value, theme: theme.value.name,
  }));
}, { deep: true });

// 激光笔:预览态下,触控笔/鼠标在画布上只留一个跟随光点(不滚动不选中);
// 手指则手动转发滚动(画布 touch-action:none 是为了拦下笔的滚动,手指的滚动在这里补回)
const laser = ref(null); // { x, y } 视口坐标
let lastTouch = null;
function laserMove(e) {
  if (editable.value) return;
  if (e.pointerType === 'touch') {
    laser.value = null;
    if (lastTouch) {
      e.currentTarget.scrollBy(lastTouch.x - e.clientX, lastTouch.y - e.clientY);
    }
    lastTouch = { x: e.clientX, y: e.clientY };
  } else {
    laser.value = { x: e.clientX, y: e.clientY };
  }
}
function laserEnd(e) {
  if (e.pointerType === 'touch') lastTouch = null;
  else laser.value = null;
}

// 荧光笔迹模式:笔迹用 canvas 2D 增量绘制(原生 shadowBlur 光晕,Safari 稳定),
// 留在画布内容层跟文字一起滚动;笔离开 1 秒后整批淡出,淡出前再落笔重置计时。
const trailFading = ref(false);
let fadeTimer = null;
let drawing = false;
const canvasEl = ref(null);
const trailEl = ref(null); // 绘制笔迹的 canvas
let ctx = null;
let lastPt = null;

function contentPoint(e) {
  const r = canvasEl.value.getBoundingClientRect();
  return { x: e.clientX - r.left + canvasEl.value.scrollLeft, y: e.clientY - r.top + canvasEl.value.scrollTop };
}
// canvas 尺寸跟随滚动区域(含 devicePixelRatio,保证光晕不糊)
function fitTrail() {
  const c = trailEl.value, host = canvasEl.value;
  if (!c || !host) return;
  const dpr = window.devicePixelRatio || 1;
  const w = host.scrollWidth, h = host.scrollHeight;
  let old = null;
  if (c.width !== w * dpr || c.height !== h * dpr) {
    // 扩大画布会清空已有内容,重设尺寸前把旧内容暂存画回来
    old = document.createElement('canvas');
    old.width = c.width; old.height = c.height;
    old.getContext('2d').drawImage(c, 0, 0);
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx = null;
  }
  if (!ctx) {
    ctx = c.getContext('2d');
    if (old) ctx.drawImage(old, 0, 0);
    setTrailStyle();
  }
}
function setTrailStyle() {
  const dpr = window.devicePixelRatio || 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.shadowColor = 'rgba(255,59,48,0.9)';
  ctx.shadowBlur = 8 * dpr;
}
function drawSegment(a, b) {
  const dpr = window.devicePixelRatio || 1;
  ctx.beginPath();
  ctx.moveTo(a.x * dpr, a.y * dpr);
  ctx.lineTo(b.x * dpr, b.y * dpr);
  ctx.stroke();
}
function trailDown(e) {
  clearTimeout(fadeTimer);
  drawing = true;
  if (trailFading.value) {
    trailFading.value = false;
    ctx.clearRect(0, 0, trailEl.value.width, trailEl.value.height);
  }
  fitTrail();
  lastPt = contentPoint(e);
  drawSegment(lastPt, lastPt); // 落笔即出一个圆点
}
function trailMove(e) {
  const p = contentPoint(e);
  drawSegment(lastPt, p);
  lastPt = p;
}
function trailUp() {
  // pointerup 后还会紧跟一个 pointerleave(释放隐式捕获),
  // drawing 标记保证一次抬笔只起一个淡出定时器
  if (!drawing) return;
  drawing = false;
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    trailFading.value = true; // CSS 0.8s 淡出,结束后清空
    setTimeout(() => {
      trailFading.value = false;
      ctx && ctx.clearRect(0, 0, trailEl.value.width, trailEl.value.height);
    }, 800);
  }, 1000);
}

// 统一分发:预览态下笔/鼠标 → 按模式处理;手指 → 转发滚动
function onPointerDown(e) {
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') trailDown(e);
  else laserMove(e);
}
function onPointerMove(e) {
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') { if (e.buttons) trailMove(e); }
  else laserMove(e);
}
function onPointerUp(e) {
  laserEnd(e);
  if (!editable.value && e.pointerType !== 'touch' && laserMode.value === 'trail') trailUp();
}
</script>

<template>
  <div class="page" :style="theme.vars">
    <div class="toolbar">
      <label class="size">
        <input type="range" v-model.number="size" min="16" max="200" />
        <span>{{ size }}px</span>
      </label>
      <div class="seg">
        <button
          v-for="t in themes" :key="t.name"
          :class="{ active: t === theme }"
          @click="theme = t"
        >{{ t.name }}</button>
      </div>
      <div v-if="!editable" class="seg">
        <button :class="{ active: laserMode === 'dot' }" @click="laserMode = 'dot'">光点</button>
        <button :class="{ active: laserMode === 'trail' }" @click="laserMode = 'trail'">笔迹</button>
      </div>
      <button
        class="toggle"
        :class="{ on: editable }"
        @click="editable = !editable"
      >{{ editable ? '可编辑' : '仅预览' }}</button>
    </div>
    <div
      ref="canvasEl"
      class="canvas"
      :class="{ laser: !editable }"
      :contenteditable="editable"
      :style="{ fontSize: size + 'px' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      荆霄鹏行楷
      <canvas v-if="laserMode === 'trail' && !editable" ref="trailEl" class="trail" :class="{ fading: trailFading }"></canvas>
    </div>
    <!-- 激光点放 body 层级,fixed 定位避免被画布滚动影响 -->
    <Teleport to="body">
      <div v-if="laser" class="laser-dot" :style="{ left: laser.x + 'px', top: laser.y + 'px' }"></div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 16px;
  gap: 12px;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--text);
  transition: background 0.2s, color 0.2s;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.size {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 160px;
  max-width: 320px;
  color: var(--muted);
  font-size: 13px;
}
.size input[type='range'] { flex: 1; accent-color: var(--accent); }
.size span { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }

.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.seg button {
  border: none;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button.active {
  color: var(--bg);
  background: var(--accent);
}

.toggle {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
  color: var(--muted);
  background: var(--canvas);
  cursor: pointer;
  transition: all 0.15s;
}
.toggle.on {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
}

.canvas {
  flex: 1;
  overflow: auto;
  padding: 24px;
  font-family: '荆霄鹏行楷', KaiTi, serif;
  background: var(--canvas);
  border: 1px solid transparent;
  border-radius: 12px;
  line-height: 1.5;
  word-break: break-all;
  outline: none;
  caret-color: var(--accent);
  transition: background 0.2s;
}
.canvas[contenteditable='true'] { border-color: var(--border); }
.canvas[contenteditable='true']:focus { border-color: var(--accent); }

/* 激光笔模式:画布吃掉所有触控,不滚动不选中 */
.canvas.laser {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: none;
}
/* 荧光笔迹层:绝对定位于滚动内容原点,随内容一起滚动 */
.canvas { position: relative; }
.trail {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  transition: opacity 0.8s;
}
.trail.fading { opacity: 0; }
.laser-dot {
  position: fixed;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px 3px #ff3b30cc, 0 0 18px 6px #ff3b3066;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 9999;
}
</style>
