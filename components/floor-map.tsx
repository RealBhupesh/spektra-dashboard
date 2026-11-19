"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  type EnvRow,
  type SeatStatus,
  STATE_META,
  seatIndex,
  seatOf,
  seatStatus,
  fmtUsd,
} from "./ui";
export type ColorMode = "status" | "spend" | "progress";
interface Props {
  everyone: EnvRow[];
  matched: Set<string> | null;
  mode: ColorMode;
  onModeChange: (m: ColorMode) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
  flash: Set<string>;
  statusFilter: Set<SeatStatus>;
  onToggleStatus: (s: SeatStatus) => void;
  onOpenTable?: () => void;
  stale?: boolean;
  lastOkAt?: number | null;
}
const colors: Record<SeatStatus, string> = {
  failed: "#ee7069",
  stuck: "#e6b25d",
  ready: "#71c4af",
  provisioning: "#729fdf",
  in_use: "#85b6cd",
  deprovisioned: "#27323b",
};
const pos = (id: string) => {
  const i = seatIndex(id),
    r = Math.floor(i / 12),
    c = i % 12;
  return new THREE.Vector3(
    (c - 5.5) * 2.05 + (c >= 6 ? 1.65 : -1.65),
    0,
    (r - 4.5) * 2.65 + (r >= 5 ? 1.9 : -1.9),
  );
};

export function FloorMap(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const engine = useRef<{
    update: () => void;
    focus: (id: string | null) => void;
    zoom: (k: number) => void;
    home: () => void;
  } | null>(null);
  const [error, setError] = useState(false),
    [hover, setHover] = useState<string | null>(null),
    [seatList, setSeatList] = useState(false);
  const selected = props.everyone.find((r) => r.id === props.selectedId);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      setError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5;
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D computer lab. Use the seat browser or All learners for keyboard access.",
    );
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101820");
    scene.fog = new THREE.Fog("#101820", 75, 125);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 180);
    camera.position.set(31, 40, 43);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 5;
    controls.maxDistance = 150;
    controls.maxPolarAngle = Math.PI * 0.43;
    controls.minPolarAngle = 0.2;
    controls.enableRotate = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // One-finger pan, two-finger pinch. Vertical page scroll remains available outside the canvas.
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    scene.add(new THREE.HemisphereLight("#dce8ff", "#35332f", 2.4));
    const key = new THREE.DirectionalLight("#fff4e5", 3.4);
    key.position.set(-12, 28, 15);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -27;
    key.shadow.camera.right = 27;
    key.shadow.camera.top = 28;
    key.shadow.camera.bottom = -28;
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.0001;
    scene.add(key);
    const rim = new THREE.DirectionalLight("#a7c2ed", 1.2);
    rim.position.set(20, 12, -20);
    scene.add(rim);
    const materials: THREE.Material[] = [],
      geometries: THREE.BufferGeometry[] = [],
      textures: THREE.Texture[] = [];
    const mat = (color: string, metalness = 0, roughness = 0.7) => {
      const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
      materials.push(m);
      return m;
    };
    const desk = mat("#424a52", 0.35, 0.52),
      edge = mat("#252d35", 0.55, 0.38),
      metal = mat("#7e8a95", 0.65, 0.35),
      plastic = mat("#171e25", 0.2, 0.5),
      keycap = mat("#363f48", 0.05, 0.72),
      fabric = mat("#333e47", 0.05, 0.95),
      floor = mat("#252e37", 0.05, 0.9),
      aisle = mat("#19232d", 0.1, 0.9),
      wall = mat("#303b46", 0.15, 0.75),
      leaf = mat("#536d5b", 0, 0.9),
      pot = mat("#8b9294", 0.1, 0.8);
    const boxes = new Map<string, THREE.BoxGeometry>();
    function box(
      g: THREE.Object3D,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      m: THREE.Material,
      shadow = true,
    ) {
      const k = [w, h, d].join();
      let geo = boxes.get(k);
      if (!geo) {
        geo =
          Math.min(w, h, d) >= 0.035
            ? new RoundedBoxGeometry(
                w,
                h,
                d,
                2,
                Math.min(0.025, Math.min(w, h, d) / 3),
              )
            : new THREE.BoxGeometry(w, h, d);
        boxes.set(k, geo);
        geometries.push(geo);
      }
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    }
    box(scene, 32, 0.22, 37, 0, -0.22, 0, floor, false);
    box(scene, 2.8, 0.025, 36.7, 0, -0.09, 0, aisle, false);
    box(scene, 31.7, 0.026, 3.3, 0, -0.08, 0.6, aisle, false);
    // Low architectural walls keep the room legible without hiding any seats.
    box(scene, 32, 1.9, 0.25, 0, 0.7, -18.3, wall);
    box(scene, 0.25, 1.9, 36.5, -15.9, 0.7, 0, wall);
    for (const x of [-15, 15])
      for (const z of [-16.7, -0.6, 16.7]) {
        box(scene, 0.6, 0.65, 0.6, x, 0.25, z, pot);
        const plant = new THREE.Group();
        plant.position.set(x, 0.55, z);
        for (let n = 0; n < 6; n++) {
          const b = box(
            plant,
            0.13,
            1.1,
            0.4,
            Math.sin(n) * 0.19,
            0.4,
            Math.cos(n) * 0.19,
            leaf,
          );
          b.rotation.z = Math.sin(n) * 0.35;
          b.rotation.y = n;
        }
        scene.add(plant);
      }
    function label(text: string, x: number, z: number) {
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 128;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#b7c4d0";
      ctx.font = "500 56px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(text, 256, 82);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      textures.push(t);
      const m = new THREE.MeshBasicMaterial({
        map: t,
        transparent: true,
        depthWrite: false,
      });
      materials.push(m);
      const geo = new THREE.PlaneGeometry(3.4, 0.85);
      geometries.push(geo);
      const p = new THREE.Mesh(geo, m);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, 0.025, z);
      scene.add(p);
    }
    for (let r = 0; r < 10; r++)
      label(
        `BENCH ${String.fromCharCode(65 + r)}`,
        -14.1,
        (r - 4.5) * 2.65 + (r >= 5 ? 1.9 : -1.9),
      );
    label("CLOUDLABS", 0, -17.1);
    let needsRender = true;
    const screenTextures = new Map<SeatStatus, THREE.CanvasTexture>();
    for (const st of Object.keys(colors) as SeatStatus[]) {
      const c = document.createElement("canvas");
      c.width = 384;
      c.height = 216;
      const q = c.getContext("2d")!;
      q.fillStyle = st === "deprovisioned" ? "#0b1219" : "#142632";
      q.fillRect(0, 0, 384, 216);
      if (st !== "deprovisioned") {
        q.fillStyle = "#223e50";
        q.fillRect(0, 0, 384, 15);
        q.fillRect(0, 15, 49, 189);
        q.fillStyle = "#456073";
        for (let n = 0; n < 7; n++) q.fillRect(9, 32 + n * 17, 28, 3);
        q.fillStyle = "#86a8bb";
        q.fillRect(65, 32, 118, 6);
        q.fillStyle = "#3e5b70";
        for (let n = 0; n < 5; n++) {
          q.fillRect(65, 52 + n * 20, 90 + (n % 3) * 29, 4);
          q.fillRect(65, 59 + n * 20, 60 + (n % 2) * 45, 2);
        }
        q.fillStyle = {
          failed: "#6f282c",
          stuck: "#645026",
          ready: "#1e5148",
          provisioning: "#294c71",
          in_use: "#274756",
          deprovisioned: "#0b1720",
        }[st];
        q.fillRect(227, 30, 142, 145);
        q.fillStyle = colors[st];
        q.font = "bold 48px system-ui";
        q.textAlign = "center";
        q.fillText(
          st === "failed"
            ? "!"
            : st === "stuck"
              ? "…"
              : st === "provisioning"
                ? "↻"
                : "✓",
          298,
          102,
        );
        q.font = "13px system-ui";
        q.fillText(STATE_META[st].label, 298, 132);
        q.fillStyle = "#274154";
        q.fillRect(0, 199, 384, 17);
        q.fillStyle = "#79a2b9";
        for (let n = 0; n < 6; n++) q.fillRect(147 + n * 17, 203, 9, 9);
      } else {
        q.fillStyle = "#1d2a36";
        q.font = "16px system-ui";
        q.textAlign = "center";
        q.fillText("Lab complete", 192, 114);
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      textures.push(t);
      screenTextures.set(st, t);
    }
    const screens = new Map<string, THREE.MeshStandardMaterial>(),
      groups = new Map<string, THREE.Group>(),
      hitboxes: THREE.Object3D[] = [];
    const glowMaterial = (color: string) => {
      const m = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.2,
        metalness: 0.3,
        roughness: 0.2,
      });
      materials.push(m);
      return m;
    };
    for (let i = 0; i < 120; i++) {
      // Inverse of the existing stable seat permutation, not a new identity map.
      const id = `env-${String(((i * 13) % 120) + 1).padStart(3, "0")}`;
      const g = new THREE.Group();
      g.position.copy(pos(id));
      scene.add(g);
      groups.set(id, g);
      box(g, 1.82, 0.1, 1.2, 0, 1.34, 0, desk);
      box(g, 1.84, 0.035, 1.22, 0, 1.29, 0, edge);
      for (const x of [-0.77, 0.77])
        for (const z of [-0.44, 0.44])
          box(g, 0.055, 1.25, 0.055, x, 0.64, z, edge);
      box(g, 1.45, 0.045, 0.05, 0, 0.38, -0.46, edge);
      // Pedestal, tilted monitor, bezel and glass screen.
      box(g, 0.38, 0.035, 0.25, -0.16, 1.42, -0.24, metal);
      box(g, 0.055, 0.32, 0.055, -0.16, 1.57, -0.31, metal);
      const display = new THREE.Group();
      display.position.set(-0.16, 1.96, -0.34);
      display.rotation.x = -0.08;
      g.add(display);
      box(display, 1.12, 0.68, 0.065, 0, 0, 0, plastic);
      const sm = glowMaterial("#ffffff");
      sm.map = screenTextures.get("deprovisioned")!;
      sm.emissiveMap = sm.map;
      screens.set(id, sm);
      box(display, 1.045, 0.586, 0.012, 0, 0.012, 0.039, sm, false);
      box(display, 0.026, 0.009, 0.013, 0.46, -0.308, 0.039, metal, false);
      // Small desktop tower, drive slot, vent rails and a power light.
      box(g, 0.25, 0.59, 0.47, 0.66, 1.675, -0.24, plastic);
      box(g, 0.22, 0.55, 0.018, 0.66, 1.675, 0.003, edge);
      box(g, 0.14, 0.018, 0.008, 0.66, 1.88, 0.018, metal, false);
      for (let k = 0; k < 5; k++)
        box(
          g,
          0.14,
          0.012,
          0.008,
          0.66,
          1.55 + k * 0.026,
          0.018,
          keycap,
          false,
        );
      box(g, 0.025, 0.025, 0.01, 0.72, 1.82, 0.019, metal, false);
      box(g, 0.84, 0.035, 0.29, -0.2, 1.415, 0.27, plastic);
      // Keys merge into a quiet material at overview distance, resolve when zoomed in.
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 13; c++)
          box(
            g,
            0.046,
            0.018,
            0.043,
            -0.56 + c * 0.058,
            1.442,
            0.17 + r * 0.058,
            keycap,
            false,
          );
      box(g, 0.28, 0.018, 0.04, -0.2, 1.443, 0.391, keycap, false);
      box(g, 0.32, 0.008, 0.35, 0.47, 1.405, 0.27, edge, false);
      box(g, 0.11, 0.045, 0.17, 0.47, 1.434, 0.25, plastic, false);
      box(g, 0.007, 0.008, 0.06, 0.47, 1.459, 0.22, metal, false);
      // Quiet upholstered task chair, seat, back and five-spoke base.
      box(g, 0.52, 0.1, 0.48, 0, 0.74, 1.02, fabric);
      box(g, 0.5, 0.51, 0.075, 0, 1.0, 1.26, fabric);
      box(g, 0.065, 0.5, 0.065, 0, 0.43, 1.02, metal);
      for (let k = 0; k < 5; k++) {
        const a = (k * Math.PI * 2) / 5;
        const b = box(
          g,
          0.035,
          0.035,
          0.42,
          Math.sin(a) * 0.18,
          0.18,
          1.02 + Math.cos(a) * 0.18,
          edge,
        );
        b.rotation.y = a;
      }
      const h = box(
        g,
        1.83,
        2.4,
        1.8,
        0,
        1.2,
        0.3,
        new THREE.MeshBasicMaterial({ visible: false }),
        false,
      );
      materials.push(h.material);
      h.userData.id = id;
      hitboxes.push(h);
    }
    // Batch repeated furniture and keycaps. Thousands of physical details,
    // a small number of GPU draw calls instead of one per keyboard key.
    scene.updateMatrixWorld(true);
    const batches = new Map<
      string,
      { geo: THREE.BufferGeometry; mat: THREE.Material; meshes: THREE.Mesh[] }
    >();
    const screenMaterials = new Set(screens.values());
    scene.traverse((o) => {
      if (
        !(o instanceof THREE.Mesh) ||
        Array.isArray(o.material) ||
        screenMaterials.has(o.material) ||
        o.userData.id ||
        o.material.transparent
      )
        return;
      const k = o.geometry.uuid + o.material.uuid;
      const b = batches.get(k) ?? {
        geo: o.geometry,
        mat: o.material,
        meshes: [] as THREE.Mesh[],
      };
      b.meshes.push(o);
      batches.set(k, b);
    });
    for (const b of batches.values()) {
      if (b.meshes.length < 2) continue;
      const inst = new THREE.InstancedMesh(b.geo, b.mat, b.meshes.length);
      b.meshes.forEach((m, i) => {
        inst.setMatrixAt(i, m.matrixWorld);
        m.removeFromParent();
      });
      inst.castShadow = b.meshes[0].castShadow;
      inst.receiveShadow = true;
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
    }
    // Selected workstation outline is spatial, not a full-scene halo.
    const outlineGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(1.92, 0.12, 1.3),
    );
    geometries.push(outlineGeo);
    const outlineMat = new THREE.LineBasicMaterial({ color: "#bad9ed" });
    materials.push(outlineMat);
    const outline = new THREE.LineSegments(outlineGeo, outlineMat);
    outline.visible = false;
    scene.add(outline);
    const ray = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    function pick(e: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(pointer, camera);
      return ray.intersectObjects(hitboxes, false)[0]?.object.userData.id as
        string | undefined;
    }
    const pd = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const pu = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7) return;
      const id = pick(e);
      if (id)
        latest.current.onSelect(latest.current.selectedId === id ? null : id);
    };
    const pm = (e: PointerEvent) => {
      if (e.buttons) return;
      const id = pick(e);
      setHover(id ?? null);
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
    };
    const pl = () => setHover(null);
    renderer.domElement.addEventListener("pointerdown", pd);
    renderer.domElement.addEventListener("pointerup", pu);
    renderer.domElement.addEventListener("pointermove", pm);
    renderer.domElement.addEventListener("pointerleave", pl);
    let goalTarget: THREE.Vector3 | null = null,
      goalCamera: THREE.Vector3 | null = null;
    const home = () => {
      needsRender = true;
      goalTarget = new THREE.Vector3(0, 0, 0);
      const aspect = el.clientWidth / el.clientHeight;
      const distance = Math.max(57, 68 / aspect);
      goalCamera = new THREE.Vector3(0.47, 0.61, 0.65)
        .normalize()
        .multiplyScalar(distance);
    };
    const selectedCanvas=document.createElement("canvas"); selectedCanvas.width=512;selectedCanvas.height=128;
    const selectedTexture=new THREE.CanvasTexture(selectedCanvas); selectedTexture.colorSpace=THREE.SRGBColorSpace;textures.push(selectedTexture);
    const selectedMat=new THREE.SpriteMaterial({map:selectedTexture,depthTest:false,transparent:true});materials.push(selectedMat);
    const selectedTag=new THREE.Sprite(selectedMat);selectedTag.scale.set(1.9,.475,1);selectedTag.visible=false;selectedTag.renderOrder=100;scene.add(selectedTag);
    const focus = (id: string | null) => {
      needsRender = true;
      if (!id) {
        home();
        outline.visible = false;
        selectedTag.visible=false;
        return;
      }
      const p = pos(id);
      const q=selectedCanvas.getContext("2d")!;q.clearRect(0,0,512,128);q.fillStyle="#d7ecf5";q.fillRect(0,0,512,128);q.fillStyle="#13212c";q.font="600 44px system-ui";q.textAlign="center";q.fillText(`${seatOf(id)}  ·  SELECTED`,256,81);selectedTexture.needsUpdate=true;selectedTag.position.copy(p).add(new THREE.Vector3(0,3,0));selectedTag.visible=true;
      outline.visible = true;
      outline.position.copy(p).add(new THREE.Vector3(0, 1.36, 0));
      goalTarget = p.clone().add(new THREE.Vector3(0, 1, 0));
      goalCamera = p.clone().add(new THREE.Vector3(4.3, 5.4, 7));
    };
    const update = () => {
      needsRender = true;
      const p = latest.current,
        max = Math.max(1, ...p.everyone.map((r) => r.spendUsd));
      for (const r of p.everyone) {
        const m = screens.get(r.id),
          g = groups.get(r.id);
        if (!m || !g) continue;
        const c =
          p.mode === "status"
            ? new THREE.Color(colors[seatStatus(r)])
            : new THREE.Color("#233744").lerp(
                new THREE.Color("#b3d7d3"),
                p.mode === "spend" ? r.spendUsd / max : r.progressPct / 100,
              );
        const tex = p.mode === "status" ? screenTextures.get(seatStatus(r))! : null;
        if (m.map !== tex) {
          m.map = tex;
          m.emissiveMap = tex;
          m.needsUpdate = true;
        }
        if (p.mode === "status") c.set("#ffffff");
        if (p.matched && !p.matched.has(r.id)) c.multiplyScalar(0.15);
        m.color.copy(c);
        m.emissive.copy(c);
        m.emissiveIntensity = r.state === "deprovisioned" ? 0.02 : 0.18;
      }
    };
    engine.current = {
      update,
      focus,
      home,
      zoom: (k) => {
        goalTarget = null;
        goalCamera = null;
        needsRender = true;
        camera.position
          .sub(controls.target)
          .multiplyScalar(k)
          .add(controls.target);
      },
    };
    update();
    home();
    let oldWidth = 0;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      needsRender = true;
      if (Math.abs(w - oldWidth) > 80 && !latest.current.selectedId) home();
      oldWidth = w;
    });
    ro.observe(el);
    let frame = 0;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (goalTarget && goalCamera) {
        needsRender = true;
        const t = reduced ? 1 : 0.22;
        controls.target.lerp(goalTarget, t);
        camera.position.lerp(goalCamera, t);
        if (camera.position.distanceTo(goalCamera) < 0.02) {
          goalTarget = null;
          goalCamera = null;
        }
      }
      const changed = controls.update();
      if (needsRender || changed) {
        renderer.render(scene, camera);
        needsRender = false;
      }
    };
    draw();
    const interrupt = () => {
      goalTarget = null;
      goalCamera = null;
    };
    controls.addEventListener("start", interrupt);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pd);
      renderer.domElement.removeEventListener("pointerup", pu);
      renderer.domElement.removeEventListener("pointermove", pm);
      renderer.domElement.removeEventListener("pointerleave", pl);
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    engine.current?.update();
  }, [props.everyone, props.matched, props.mode]);
  useEffect(() => {
    engine.current?.focus(props.selectedId);
  }, [props.selectedId]);
  const hovered = props.everyone.find((r) => r.id === hover);
  const counts = props.everyone.reduce(
    (a, r) => {
      a[seatStatus(r)]++;
      return a;
    },
    {
      failed: 0,
      stuck: 0,
      in_use: 0,
      ready: 0,
      provisioning: 0,
      deprovisioned: 0,
    },
  );
  return (
    <section className="spatial-room" aria-label="Lab floor map">
      <div className="room-topline">
        <div>
          <span className="room-eyebrow">
            {selected
              ? `ENTIRE LAB / BENCH ${seatOf(selected.id)[0]} / SEAT ${seatOf(selected.id)}`
              : "120-SEAT COMPUTER LAB"}
          </span>
          <h2>
            {selected
              ? `${seatOf(selected.id)} · ${selected.learnerName}`
              : "A place for every learner."}
          </h2>
        </div>
        <div className="room-seg" role="group" aria-label="Color seats by">
          {(["status", "spend", "progress"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={props.mode === m}
              onClick={() => props.onModeChange(m)}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {props.stale && (
        <p className="room-notice" role="status">
          Showing the last snapshot
          {props.lastOkAt
            ? ` from ${new Date(props.lastOkAt).toLocaleTimeString()}`
            : ""}
          . Reconnecting. PCs may be out of date.
        </p>
      )}
      {props.matched !== null && (
        <p className="room-notice" data-filter-note>
          {props.matched.size} of {props.everyone.length} PCs highlighted.
          Summary and attention count the whole room.
        </p>
      )}
      <div
        className="room-stage"
        ref={host}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "+" || e.key === "=") engine.current?.zoom(0.8);
          if (e.key === "-") engine.current?.zoom(1.25);
          if (e.key === "0") engine.current?.home();
        }}
      >
        {error && (
          <div className="room-fallback">
            <h3>3D view is unavailable on this device.</h3>
            <p>
              Every learner, filter and action is still available in the list.
            </p>
            <button className="btn" onClick={props.onOpenTable}>
              Open all learners
            </button>
          </div>
        )}
        {props.loading && (
          <div className="room-loading" role="status">
            Preparing your workshop…
          </div>
        )}
        {hovered && (
          <div className="room-hover" role="status">
            <b>
              {seatOf(hovered.id)} · {hovered.learnerName}
            </b>
            <span style={{ color: colors[seatStatus(hovered)] }}>
              {STATE_META[seatStatus(hovered)].label} · {hovered.progressPct}%
              complete
            </span>
            <span>{fmtUsd(hovered.spendUsd)} spent · Click to inspect</span>
          </div>
        )}
        <div className="room-hint">
          Drag to explore <span>·</span> Scroll to zoom <span>·</span>{" "}
          Right-drag to orbit
        </div>
        <div className="room-navigation">
          <button onClick={() => props.onSelect(null)} disabled={!selected}>
            ↖ Entire lab
          </button>
          <div role="group" aria-label="Zoom lab">
            <button
              aria-label="Zoom out"
              onClick={() => engine.current?.zoom(1.25)}
            >
              −
            </button>
            <button
              aria-label="Zoom in"
              onClick={() => engine.current?.zoom(0.8)}
            >
              +
            </button>
            <button onClick={() => engine.current?.home()}>Fit</button>
          </div>
        </div>
        <div
          className="room-minimap"
          aria-label="Seat map, click a seat to focus"
        >
          {props.everyone
            .slice()
            .sort((a, b) => seatIndex(a.id) - seatIndex(b.id))
            .map((r) => (
              <button
                key={r.id}
                tabIndex={-1}
                aria-label={`Focus seat ${seatOf(r.id)}, ${r.learnerName}`}
                title={`${seatOf(r.id)} · ${r.learnerName}`}
                onClick={() => props.onSelect(r.id)}
                style={{
                  background:
                    props.selectedId === r.id
                      ? "#eff8ff"
                      : colors[seatStatus(r)],
                }}
              />
            ))}
        </div>
      </div>
      {props.mode !== "status" && <div className="room-scale"><span>{props.mode === "spend" ? "Spend per PC" : "Lab progress"}</span><b>{props.mode === "spend" ? "$0" : "0%"}</b><i/><b>{props.mode === "spend" ? fmtUsd(Math.max(0,...props.everyone.map(r=>r.spendUsd))) : "100%"}</b></div>}
      <div className="room-legend">
        {(Object.keys(counts) as SeatStatus[]).map((s) => (
          <button
            key={s}
            aria-pressed={props.statusFilter.has(s)}
            onClick={() => props.onToggleStatus(s)}
          >
            <i style={{ background: colors[s] }} />
            {STATE_META[s].label} <b>{counts[s]}</b>
          </button>
        ))}
        <button
          className="seat-browser-toggle"
          aria-expanded={seatList}
          onClick={() => setSeatList(!seatList)}
        >
          Browse seats {seatList ? "−" : "+"}
        </button>
      </div>
      {seatList && (
        <div
          className="seat-browser"
          role="group"
          aria-label="Lab PCs, bench A at the back"
          onKeyDown={(e) => {
            const delta = (
              {
                ArrowRight: 1,
                ArrowLeft: -1,
                ArrowDown: 12,
                ArrowUp: -12,
              } as Record<string, number>
            )[e.key];
            if (delta === undefined) return;
            const t = (e.target as HTMLElement).closest("button");
            if (!t) return;
            e.preventDefault();
            const buttons = Array.from(
              e.currentTarget.querySelectorAll("button"),
            );
            const n = Math.max(
              0,
              Math.min(buttons.length - 1, buttons.indexOf(t) + delta),
            );
            buttons[n]?.focus();
          }}
        >
          {props.everyone
            .slice()
            .sort((a, b) => seatIndex(a.id) - seatIndex(b.id))
            .map((r, i) => (
              <button
                key={r.id}
                data-env-id={r.id}
                data-idx={i}
                data-st={seatStatus(r)}
                aria-pressed={r.id === props.selectedId}
                onClick={() => props.onSelect(r.id)}
              >
                <b>{seatOf(r.id)}</b>
                <span>{r.learnerName}</span>
                <small>{STATE_META[seatStatus(r)].label}</small>
              </button>
            ))}
        </div>
      )}
    </section>
  );
}
