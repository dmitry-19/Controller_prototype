// js/characterController.js
// =================================================================================================
//  CharacterController — единый «правильный» контроллер персонажа, собранный из актуальных идей
//  мастер-слейв прототипа (master-slave-prototype) и модулей репозитория.
//
//  АРХИТЕКТУРА (Master → weights → Slave → Skinning):
//
//   [Input/AI] ──► MasterController (кинематический аватар: движение, опора, шаги, анимация)
//                     │  charState: IDLE | WALKING | RUNNING | FALLING
//                     ▼
//                  WeightMixer (логика смешения весов следования)
//   followingScale(стабильность/ragdoll-чардж) × staggerCoef × strength(loosing/gaining)
//   × limp/stress-effF/effT × distance-pushback × IK-weights
//                     ▼
//                  SlaveController (PD-приводы физ. тел: impulse + torqueImpulse)
//                     │  6DOF-суставы с анатомическими лимитами, welds, support guard
//                     ├──► BalanceSystem (ЦМ над опорой + вертикализация таза)
//                     ├──► ReactionSystem  (удар → limp/stress-волна по иерархии, stagger, head)
//                     ├──► RagdollManager  (потеря стабильности → falling/getup с гистерезисом)
//                     ├──► FootIK          (ступни читают поверхность рейкастами, BoneIKController)
//                     └──► SpineIK / Look  (BoneLookController, вес = followingScale)
//                     ▼
//                  SkinningSync (мировые матрицы физ. тел → локальные трансформы костей скинета)
//
//  ИДЕИ, ИЗВЛЕЧЁННЫЕ ИЗ РЕПОЗИТОРИЯ:
//   • master-slave-prototype: PD-следование за мастером, профили сил/моментов по типам суставов,
//     сварные кисти/стопы, чтение опоры (коллизии + рейкасты), охрана опоры, stagger-таймер,
//     stress-диффузия по иерархии, ragdoll-чардж с порогами, master-анимация (группы или процедурная).
//   • ragdollPhysics.js / stateMachine.js: состояния Knockdown/GetUp/Ragdoll, импульсы ударов.
//   • ikSystem.js: BoneIKController для ног, raycast по поверхностям, BoneLookController для spine.
//   • movement.js: inputLock / externalBias / externalSpeedLimit — подключение AI без переписывания кода.
//   • healthSystem/staminaSystem: hook onRagdoll / onImpact для урона и выносливости.
//   • krl.js: реакция-позы (блоки) могут подавать additional IK-targets через setHandTarget().
// =================================================================================================

// --------------------------------------------------------------------------- утилиты
const clampF = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpF = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clampF((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function smoothDampAngle(cur, tgt, dt, smoothTime) {
    let d = tgt - cur;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return cur + d * (1 - Math.exp(-dt / Math.max(0.01, smoothTime)));
}
function quatToRotVec(q) {
    let w = q.w, x = q.x, y = q.y, z = q.z;
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    const s = Math.sqrt(x * x + y * y + z * z);
    if (s < 1e-6) return new BABYLON.Vector3(2 * x, 2 * y, 2 * z);
    const a = 2 * Math.atan2(s, w);
    return new BABYLON.Vector3((x / s) * a, (y / s) * a, (z / s) * a);
}
function rotateVecByQuat(v, q) {
    const qv = new BABYLON.Quaternion(v.x, v.y, v.z, 0);
    const r = q.multiply(qv).multiply(q.conjugate());
    return new BABYLON.Vector3(r.x, r.y, r.z);
}
function safeCross(a, b) {
    const c = BABYLON.Vector3.Cross(a, b);
    if (c.lengthSquared() < 1e-6) { const f = new BABYLON.Vector3(0, 0, 0); a.getNormalToRef(f); return f.normalize(); }
    return c.normalize();
}

// --------------------------------------------------------------------------- дефолтные параметры
export const DEFAULT_PARAMS = {
    // Slave PD-привод
    KpPos: 800, zetaPos: 0.85, maxAccel: 700,
    KpAng: 2500, zetaAng: 1.0, maxJointTorque: 12000,
    ANG_ACC_MAX: 20000,
    minContactForce: 0.1, minContactTorque: 0.2,
    looseStrengthLerp: 1.0, gainStrengthLerp: 0.3, deadTime: 4.0,
    // Master locomotion
    walkSpeed: 3.0, runSpeed: 7.0, turnSmoothTime: 0.25,
    pushBackSpeed: 7.0, maxPossibleDistanceFromRagdoll: 2.0,
    groundDistance: 0.03, gravity: 9.81, maxStepHeight: 0.35, footSupportTol: 0.15,
    // Баланс
    KpBal: 40, KdBal: 12, KpUpright: 300, KdUpright: 30, maxBalForce: 40,
    // Реакции на удары
    reactMinSev: 1.2, waveStrength: 0.7, waveDelay: 0.08,
    staggerForce: 15, recoveryRate: 1.2,
    // Стабильность / ragdoll
    stressFlowRate: 6, stressSpread: 0.65, stressDecayRate: 0.8, stressWeakenAmount: 0.5,
    stabilityDropThreshold: 0.35, stabilityRecoverThreshold: 0.55, ragdollDropDelay: 0.6,
    // Захват (spring drag)
    dragStiff: 500, dragDamp: 30,
    linDamp: 0.1, angDamp: 0.4,
    // IK
    ikEnabled: true, ikFootLift: 0.05, ikSlerp: 0.9,
};

// --------------------------------------------------------------------------- группы коллайдеров
const DEFAULT_BONE_GROUPS = {
    'pelvis_grp': ['pelvis', 'hip', 'Hips'],
    'lower_back': ['spine_01'],
    'chest': ['spine_02', 'spine_03'],
    'neck': ['neck_01'],
    'head': ['head', 'head_leaf'],
    'hand_l': ['hand_l'],
    'hand_r': ['hand_r'],
    'foot_l': ['foot_l', 'ball_l'],
    'foot_r': ['foot_r', 'ball_r'],
};
const DEFAULT_EXCLUDE_BONES = ['root', '__root__', 'Root'];
const SKIP_RE = /thumb|index|middle_|pinky|ring|finger|palm|toe|ball_leaf/i;
const WELD_RE = /(hand|wrist|foot|ankle|ball)(?!_leaf)/i;

const COL_GROUP = { HEAD: 1 << 0, TORSO: 1 << 1, LEFT_ARM: 1 << 2, RIGHT_ARM: 1 << 3, LEFT_LEG: 1 << 4, RIGHT_LEG: 1 << 5, GROUND: 1 << 6 };
const COL_MASK = {
    HEAD:       COL_GROUP.TORSO | COL_GROUP.LEFT_ARM | COL_GROUP.RIGHT_ARM | COL_GROUP.LEFT_LEG | COL_GROUP.RIGHT_LEG | COL_GROUP.GROUND,
    TORSO:      COL_GROUP.HEAD | COL_GROUP.LEFT_ARM | COL_GROUP.RIGHT_ARM | COL_GROUP.LEFT_LEG | COL_GROUP.RIGHT_LEG | COL_GROUP.GROUND,
    LEFT_ARM:   COL_GROUP.HEAD | COL_GROUP.RIGHT_ARM | COL_GROUP.LEFT_LEG | COL_GROUP.RIGHT_LEG | COL_GROUP.GROUND,
    RIGHT_ARM:  COL_GROUP.HEAD | COL_GROUP.LEFT_ARM | COL_GROUP.LEFT_LEG | COL_GROUP.RIGHT_LEG | COL_GROUP.GROUND,
    LEFT_LEG:   COL_GROUP.HEAD | COL_GROUP.TORSO | COL_GROUP.RIGHT_ARM | COL_GROUP.RIGHT_LEG | COL_GROUP.GROUND,
    RIGHT_LEG:  COL_GROUP.HEAD | COL_GROUP.TORSO | COL_GROUP.LEFT_ARM | COL_GROUP.LEFT_LEG | COL_GROUP.GROUND,
    GROUND: ~0,
};

function classifyGroup(name) {
    const n = name.toLowerCase();
    const isR = n.includes('_r') || n.includes('right') || n.endsWith('.r');
    if (n.includes('head') || n.includes('neck')) return 'HEAD';
    if (n.includes('spine') || n.includes('chest') || n.includes('back') || n.includes('pelvis') || n.includes('hip')) return 'TORSO';
    const armKw = ['clavicle', 'upperarm', 'lowerarm', 'upper_arm', 'lower_arm', 'hand', 'wrist', 'arm'];
    const legKw = ['thigh', 'calf', 'upper_leg', 'lower_leg', 'foot', 'ball', 'leg', 'shin'];
    if (armKw.some(k => n.includes(k))) return isR ? 'RIGHT_ARM' : 'LEFT_ARM';
    if (legKw.some(k => n.includes(k))) return isR ? 'RIGHT_LEG' : 'LEFT_LEG';
    return 'TORSO';
}

function massFor(name) {
    const n = name.toLowerCase();
    if (n.includes('pelvis') || n.includes('hip')) return 15;
    if (n.includes('lower_back') || n.includes('spine_01')) return 9;
    if (n.includes('spine') || n.includes('chest') || n.includes('back')) return 8;
    if (n.includes('neck')) return 2;
    if (n.includes('head')) return 5;
    if (n.includes('clavicle')) return 2;
    if (n.includes('upperarm') || n.includes('upper_arm')) return 4;
    if (n.includes('lowerarm') || n.includes('lower_arm')) return 3;
    if (n.includes('hand')) return 1;
    if (n.includes('thigh') || n.includes('upper_leg')) return 8;
    if (n.includes('calf') || n.includes('lower_leg')) return 4;
    if (n.includes('foot') || n.includes('ball')) return 2;
    return 3;
}

const D2R = Math.PI / 180;

function jointTypeFor(name) {
    const n = name.toLowerCase();
    if (/upperarm|upper_arm|shoulder/.test(n)) return 'shoulder';
    if (/lowerarm|lower_arm|forearm|elbow/.test(n)) return 'elbow';
    if (/thigh|upper_leg|upperleg/.test(n)) return 'hip';
    if (/calf|lower_leg|lowerleg|shin|knee/.test(n)) return 'knee';
    return 'spine';
}
function forceProfileFor(jt) {
    if (jt === 'hip' || jt === 'knee') return 1.1;
    if (jt === 'shoulder' || jt === 'elbow') return 0.9;
    if (jt === 'weld') return 0.6;
    return 1.2;
}
function torqueProfileFor(jt) {
    if (jt === 'weld') return 0.5;
    if (jt === 'spine') return 1.6;
    if (jt === 'hip' || jt === 'knee') return 1.3;
    if (jt === 'shoulder' || jt === 'elbow') return 1.0;
    return 1.0;
}
function spineLimits(name) {
    const n = name.toLowerCase();
    if (/pelvis|hip/.test(n))                 return { X: [-10, 10], Y: [-10, 10], Z: [-8, 8] };
    if (/lower_back|spine_01|lumbar/.test(n)) return { X: [-20, 40], Y: [-16, 16], Z: [-12, 12] };
    if (/spine|chest|back|thoracic/.test(n))  return { X: [-15, 25], Y: [-14, 14], Z: [-18, 18] };
    if (/neck/.test(n))                       return { X: [-30, 40], Y: [-35, 35], Z: [-50, 50] };
    if (/head/.test(n))                       return { X: [-20, 20], Y: [-25, 25], Z: [-30, 30] };
    if (/clavicle/.test(n))                   return { X: [-10, 10], Y: [-12, 12], Z: [-8, 8] };
    return { X: [-20, 20], Y: [-20, 20], Z: [-15, 15] };
}

// =================================================================================================
//  Анатомические оси и лимиты суставов в мировых координатах (из прототипа)
// =================================================================================================
class JointAxes {
    static distalDir(bone, mesh, excludeBones) {
        const j = bone.getAbsolutePosition(mesh);
        const kids = bone.getChildren ? bone.getChildren() : [];
        let child = kids.find(k => !excludeBones.includes(k.name) && !SKIP_RE.test(k.name) && !/leaf/i.test(k.name)) || kids[0];
        if (child) {
            const d = child.getAbsolutePosition(mesh).subtract(j);
            if (d.lengthSquared() > 1e-8) return d.normalize();
        }
        for (const ax of [BABYLON.Axis.Y, BABYLON.Axis.X]) {
            try { const dd = bone.getDirection(ax, mesh); if (dd.lengthSquared() > 1e-8) return dd.normalize(); } catch (_) {}
        }
        return new BABYLON.Vector3(0, -1, 0);
    }

    // Ключевые точки скелета: up/right/forward/center — для ориентации лимитов
    static computeLandmarks(skeleton, mesh, excludeBones) {
        const up = new BABYLON.Vector3(0, 1, 0);
        const armRe = /upperarm|upper_arm|clavicle|shoulder|arm/i;
        const legRe = /thigh|upper_leg|leg/i;
        const sideL = /_l$|_l[^a-z]|left|\.l$/i;
        const sideR = /_r$|_r[^a-z]|right|\.r$/i;
        let lp = null, rp = null;
        const center = BABYLON.Vector3.Zero();
        let cn = 0;
        const find = (re) => {
            for (const b of skeleton.bones) {
                if (excludeBones.includes(b.name) || SKIP_RE.test(b.name)) continue;
                let p; try { p = b.getAbsolutePosition(mesh); } catch (_) { continue; }
                center.addInPlace(p); cn++;
                if (!re.test(b.name)) continue;
                if (sideL.test(b.name) && !lp) lp = p;
                else if (sideR.test(b.name) && !rp) rp = p;
            }
        };
        find(armRe);
        if (!(lp && rp)) { lp = null; rp = null; center.set(0, 0, 0); cn = 0; find(legRe); }
        if (cn > 0) center.scaleInPlace(1 / cn);
        let right;
        if (lp && rp) right = rp.subtract(lp);
        else if (rp) right = rp.subtract(center);
        else if (lp) right = center.subtract(lp);
        else { try { right = mesh.getDirection(BABYLON.Axis.X); } catch (_) { right = new BABYLON.Vector3(1, 0, 0); } }
        right = right.subtract(up.scale(BABYLON.Vector3.Dot(right, up)));
        if (right.lengthSquared() < 1e-6) right = new BABYLON.Vector3(1, 0, 0);
        right.normalize();
        const forward = BABYLON.Vector3.Cross(up, right).normalize();
        return { up, right, forward, center };
    }

    static build(ref, LM, mesh, excludeBones) {
        const jt = jointTypeFor(ref.name);
        const jw = ref.bone.getAbsolutePosition(mesh);
        const sideR = BABYLON.Vector3.Dot(jw.subtract(LM.center), LM.right) > 0;
        const lat = sideR ? LM.right : LM.right.scale(-1);
        let Xw, Yw, lim;
        if (jt === 'spine') {
            Xw = safeCross(LM.up, LM.forward);
            Yw = safeCross(LM.up, LM.right);
            lim = spineLimits(ref.name);
        } else {
            const r = JointAxes.distalDir(ref.bone, mesh, excludeBones);
            if (jt === 'shoulder') {
                const tPose = Math.abs(BABYLON.Vector3.Dot(r, LM.right)) > 0.6;
                Xw = safeCross(r, LM.forward);
                if (tPose) { Yw = safeCross(r, LM.up); lim = { X: [-45, 125], Y: [-85, 95] }; }
                else { Yw = safeCross(r, lat); lim = { X: [-60, 175], Y: [-30, 160] }; }
            } else if (jt === 'elbow') {
                Xw = safeCross(r, LM.forward); Yw = r.clone();
                lim = { X: [-5, 148], Y: [-85, 85], Z: [0, 0] };
            } else if (jt === 'hip') {
                Xw = safeCross(r, LM.forward); Yw = safeCross(r, lat);
                lim = { X: [-30, 120], Y: [-30, 50] };
            } else { // knee
                Xw = safeCross(r, LM.forward.scale(-1)); Yw = r.clone();
                lim = { X: [-5, 140], Y: [-10, 10], Z: [0, 0] };
            }
            if (jt === 'shoulder' || jt === 'hip') {
                const Zw0 = BABYLON.Vector3.Cross(Xw, Yw).normalize();
                const axisSign = BABYLON.Vector3.Dot(Zw0, r) >= 0 ? 1 : -1;
                const twistSign = (sideR ? 1 : -1) * axisSign;
                const intMax = jt === 'shoulder' ? 80 : 45;
                const extMax = jt === 'shoulder' ? 100 : 60;
                lim.Z = twistSign > 0 ? [-intMax, extMax] : [-extMax, intMax];
            }
        }
        Xw = Xw.clone().normalize();
        Yw = Yw.subtract(Xw.scale(BABYLON.Vector3.Dot(Xw, Yw))).normalize();
        const Zw = BABYLON.Vector3.Cross(Xw, Yw).normalize();
        return { Xw, Yw, Zw, lim, jt };
    }
}

// =================================================================================================
//  MASTER — кинематический аватар-цель. Читает ввод (или AI-смещение), ходит по опорам,
//  не залезает на препятствия выше maxStepHeight, тянется к рагдоллу при рассогласовании.
// =================================================================================================
class MasterController {
    constructor(cc) {
        this.cc = cc;
        this.mesh = null;
        this.skeleton = null;
        this.groups = { idle: null, walk: null, run: null, fall: null };
        this.curGroup = null;
        this.mode = 'procedural';           // 'groups' — ретаргет клипов, 'procedural' — синтетический локомотивный цикл
        this.yaw = 0;
        this.walkPhase = 0;
        this.ampCur = 0;
        this.fallBlend = 0;
        this.fallVel = 0;
        this.bobY = 0;
        this.grounded = true;
        this.state = 'IDLE';               // IDLE | WALKING | RUNNING | FALLING
        this.animBones = [];
        this.restQuat = new Map();
        this.boneOrder = [];
        this.worldQ = new Map();
    }

    create(sourceMesh, skeleton, animGroups, LM) {
        this.destroy();
        const cc = this.cc;
        const m = sourceMesh.clone('master_avatar', null, true, false);
        if (!m) return;
        if (m.skeleton === skeleton || !m.skeleton) m.skeleton = skeleton.clone('master_skeleton');
        this.mesh = m;
        this.skeleton = m.skeleton;
        m.isPickable = false;
        if (m.material) {
            const gmat = m.material.clone('masterMat');
            if (gmat) {
                gmat.alpha = cc.options.masterAlpha ?? 0.25;
                if (gmat.emissiveColor !== undefined) gmat.emissiveColor = new BABYLON.Color3(0.1, 0.85, 0.3);
                m.material = gmat;
            }
        }
        m.setEnabled(cc.options.masterVisible !== false);

        // rest-кватернионы и порядок обхода (родители раньше детей)
        const sc = new BABYLON.Vector3(), q = new BABYLON.Quaternion(), p = new BABYLON.Vector3();
        for (const b of this.skeleton.bones) {
            b.getLocalMatrix().decompose(sc, q, p);
            this.restQuat.set(b, q.clone());
        }
        this.boneOrder = this.skeleton.bones.slice().sort((a, b) => this._depth(a) - this._depth(b));

        const sL = /_l$|_l[^a-z]|left|\.l$/i, sR = /_r$|_r[^a-z]|right|\.r$/i;
        this.animBones = [];
        for (const b of this.skeleton.bones) {
            const nm = b.name;
            if (cc.excludeBones.includes(nm) || SKIP_RE.test(nm) || WELD_RE.test(nm)) continue;
            const jt = jointTypeFor(nm);
            let side = sL.test(nm) ? 'L' : (sR.test(nm) ? 'R' : null);
            if (!side && (jt === 'hip' || jt === 'knee' || jt === 'shoulder' || jt === 'elbow')) {
                try { side = BABYLON.Vector3.Dot(b.getAbsolutePosition(m).subtract(LM.center), LM.right) >= 0 ? 'R' : 'L'; }
                catch (_) { side = 'R'; }
            }
            this.animBones.push({ bone: b, jt, side, name: nm });
        }

        // Клип-группы: ретаргет на скелет мастера и классификация по именам
        for (const g of (animGroups || [])) {
            try { g.stop(); } catch (_) {}
            try { g.retargetTo(this.skeleton); } catch (_) {}
            const n = (g.name || '').toLowerCase();
            if (/idle|stand|breath|neutral/i.test(n) && !this.groups.idle) this.groups.idle = g;
            else if (/walk/i.test(n) && !this.groups.walk) this.groups.walk = g;
            else if (/run|sprint|jog/i.test(n) && !this.groups.run) this.groups.run = g;
            else if (/fall|jump|air|float/i.test(n) && !this.groups.fall) this.groups.fall = g;
        }
        this.mode = (this.groups.idle && (this.groups.walk || this.groups.run)) ? 'groups' : 'procedural';
    }

    _depth(b) { let d = 0, pp = b.getParent(); while (pp) { d++; pp = pp.getParent(); } return d; }

    destroy() {
        for (const g of Object.values(this.groups)) { if (g) { try { g.stop(); } catch (_) {} } }
        if (this.skeleton) { try { this.skeleton.dispose(); } catch (_) {} }
        if (this.mesh) { try { this.mesh.dispose(false, true); } catch (_) {} }
        this.mesh = null; this.skeleton = null; this.curGroup = null;
        this.groups = { idle: null, walk: null, run: null, fall: null };
    }

    // Директивы движения: из клавиатуры (options.getInput) ИЛИ от AI (externalIntent).
    getIntent() {
        const cc = this.cc;
        const ext = cc.externalIntent; // { dir: Vector3(y=0), running: bool } от AutonomousBehaviour/HostileAI
        if (ext && ext.dir && ext.dir.lengthSquared() > 1e-6) {
            return { moveDir: ext.dir.clone().normalize(), running: !!ext.running, moving: true };
        }
        const keys = cc.keys;
        const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
        const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
        if (!fwd && !side) return { moveDir: BABYLON.Vector3.Zero(), running: false, moving: false };
        const cam = cc.camera;
        const camDir = cam.getForwardRay().direction.clone();
        camDir.y = 0;
        if (camDir.lengthSquared() < 1e-6) camDir.set(0, 0, -1);
        camDir.normalize();
        const camRight = BABYLON.Vector3.Cross(camDir, new BABYLON.Vector3(0, 1, 0)).normalize();
        const moveDir = camDir.scale(fwd).add(camRight.scale(side));
        if (moveDir.lengthSquared() < 1e-8) moveDir.set(0, 0, 1);
        return { moveDir: moveDir.normalize(), running: keys.has('ShiftLeft') || keys.has('ShiftRight'), moving: true };
    }

    update(dt, t) {
        const cc = this.cc, P = cc.params;
        if (!this.mesh || !cc.rootRef) return;
        const pos = this.mesh.position;

        // Опора под мастером
        const ray = new BABYLON.Ray(pos.add(new BABYLON.Vector3(0, 0.35, 0)), new BABYLON.Vector3(0, -1, 0), 6);
        const hit = cc.scene.pickWithRay(ray, cc.supportPredicate);
        let groundY = 0;
        if (hit && hit.hit && hit.pickedPoint) groundY = hit.pickedPoint.y;
        this.grounded = (pos.y - groundY) < P.groundDistance + 0.15;

        const intent = this.getIntent();
        this.state = !this.grounded ? 'FALLING' : (intent.moving ? (intent.running ? 'RUNNING' : 'WALKING') : 'IDLE');
        if (this.state !== 'FALLING') this.fallVel = 0;

        // Поворот к направлению движения (плавно, shortest arc)
        if (intent.moving) {
            const targetYaw = Math.atan2(
                BABYLON.Vector3.Cross(cc.LM.forward, intent.moveDir).y,
                BABYLON.Vector3.Dot(cc.LM.forward, intent.moveDir)
            );
            this.yaw = smoothDampAngle(this.yaw, targetYaw, dt, P.turnSmoothTime);
        }
        this.mesh.rotationQuaternion = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), this.yaw);

        // Привязка к рагдоллу: push-back растёт с рассогласованием (smoothstep по дистанции)
        const slaveRootPos = cc.rootRef.mesh.getAbsolutePosition();
        const s2m = slaveRootPos.subtract(pos); s2m.y = 0;
        const dist = s2m.length();
        const ratio = clampF(dist / P.maxPossibleDistanceFromRagdoll, 0, 1);
        const mag = smoothstep(0, 1, ratio);
        const pushVec = dist > 1e-5 ? s2m.scale(Math.min(mag, dist) / dist) : BABYLON.Vector3.Zero();
        const pushScale = 1 + (1 - cc.followingScale) * 2;
        const masterMoveScale = clampF(cc.followingScale, 0, 1);

        if (this.state === 'FALLING') {
            this.fallVel -= P.gravity * dt;
            pos.y += this.fallVel * dt;
        } else if (this.state === 'IDLE') {
            pos.addInPlace(pushVec.scale(P.pushBackSpeed * pushScale * dt));
        } else {
            const baseSpeed = this.state === 'RUNNING' ? P.runSpeed : P.walkSpeed;
            const speedLimit = cc.externalSpeedLimit ?? 1.0;
            const forward = intent.moveDir.scale(baseSpeed * speedLimit * masterMoveScale);
            // Support guard: мастер не шагает на поверхность выше maxStepHeight
            if (cc.supportGuard && forward.lengthSquared() > 1e-8) {
                const dirN = intent.moveDir.clone(); dirN.normalize();
                const aheadY = cc.raycastSupportY(pos.x + dirN.x * 0.5, pos.z + dirN.z * 0.5, pos.y + 1.5);
                if (aheadY !== null && aheadY - groundY > P.maxStepHeight) forward.set(0, 0, 0);
            }
            const back = pushVec.scale(P.pushBackSpeed * pushScale);
            pos.addInPlace(forward.add(back).scale(dt));
        }

        const floorY = groundY + P.groundDistance + this.bobY;
        if (pos.y < floorY) { pos.y = floorY; this.fallVel = 0; }
        else if (this.grounded) pos.y = lerpF(pos.y, floorY, Math.min(1, dt * 12));

        this.animate(dt, t);
        try { this.mesh.computeWorldMatrix(true); } catch (_) {}
        try { this.skeleton.computeAbsoluteMatrices(); } catch (_) {}
    }

    animate(dt, t) {
        const cc = this.cc;
        if (!this.mesh || !this.skeleton) return;
        if (this.mode === 'groups') {
            let want = this.groups.idle;
            if (this.state === 'FALLING') want = this.groups.fall || this.groups.idle;
            else if (this.state === 'RUNNING') want = this.groups.run || this.groups.walk || this.groups.idle;
            else if (this.state === 'WALKING') want = this.groups.walk || this.groups.idle;
            if (want && this.curGroup !== want) {
                if (this.curGroup) { try { this.curGroup.stop(); } catch (_) {} }
                try { want.play(true); } catch (_) {}
                this.curGroup = want;
            }
            this.bobY = 0;
            return;
        }

        // Процедурный локомотивный цикл (идея из прототипа: синусоиды по фазе шага + дыхание + fall-blend)
        const moving = (this.state === 'WALKING' || this.state === 'RUNNING') && this.grounded;
        const rate = this.state === 'RUNNING' ? 11 : 7.5;
        if (moving) this.walkPhase += dt * rate;
        this.ampCur += ((moving ? 1 : 0) - this.ampCur) * Math.min(1, dt * 6);
        this.fallBlend += ((this.state === 'FALLING' ? 1 : 0) - this.fallBlend) * Math.min(1, dt * 5);
        const A = this.ampCur, ph = this.walkPhase, F = this.fallBlend;
        const breath = Math.sin(t * 1.7);

        const adds = new Map();
        const R = cc.LM.right, U = cc.LM.up;
        for (const ab of this.animBones) {
            const phSide = ph + (ab.side === 'L' ? 0 : Math.PI);
            let angle = 0, axis = R;
            if (ab.jt === 'hip') {
                angle = A * Math.sin(phSide) * 35 * D2R;
                angle = lerpF(angle, -25 * D2R, F);
            } else if (ab.jt === 'knee') {
                angle = -A * Math.max(0, Math.sin(phSide + 0.9)) * 75 * D2R - 3 * D2R;
                angle = lerpF(angle, -50 * D2R, F);
            } else if (ab.jt === 'shoulder') {
                angle = A * Math.sin(phSide + Math.PI) * 32 * D2R + (1 - A) * breath * 1.5 * D2R;
                // Поднятие рук при падении — попытка сгруппироваться
                angle = lerpF(angle, 150 * D2R, F);
            } else if (ab.jt === 'elbow') {
                angle = A * Math.max(0, Math.sin(phSide + Math.PI - 0.8)) * 55 * D2R + 8 * D2R;
                angle = lerpF(angle, 45 * D2R, F);
            } else if (ab.jt === 'spine') {
                const n = ab.name.toLowerCase();
                if (/pelvis|hips/.test(n) && !/thigh|upper_leg/.test(n)) {
                    axis = U; angle = -A * Math.sin(ph) * 4 * D2R;
                } else if (/neck/.test(n)) {
                    axis = U; angle = -A * Math.sin(ph) * 2 * D2R;
                } else if (/head/.test(n)) {
                    axis = U; angle = -A * Math.sin(ph) * 2.5 * D2R;
                } else if (/chest|spine|back|thorax|abdomen|torso/.test(n)) {
                    const qYaw = BABYLON.Quaternion.RotationAxis(U, A * Math.sin(ph) * 5 * D2R);
                    const qPitch = BABYLON.Quaternion.RotationAxis(R, breath * 1.8 * D2R * (1 - A * 0.5) + F * 8 * D2R);
                    adds.set(ab.bone, qYaw.multiply(qPitch));
                    continue;
                } else continue;
            } else continue;
            adds.set(ab.bone, BABYLON.Quaternion.RotationAxis(axis, angle));
        }

        // Внешние reaction-pose смещения (например блоки из KRL): additive поверх цикла
        if (cc.additionalMasterOffsets) {
            for (const [boneName, q] of cc.additionalMasterOffsets.entries()) {
                const b = this.skeleton.bones.find(x => x.name === boneName);
                if (b) adds.set(b, q);
            }
        }

        this.worldQ.clear();
        const IDQ = BABYLON.Quaternion.Identity();
        for (const bone of this.boneOrder) {
            const parent = bone.getParent();
            const qPA = parent ? (this.worldQ.get(parent) || IDQ) : IDQ;
            const qRest = this.restQuat.get(bone) || IDQ;
            const qBase = qPA.multiply(qRest);
            const add = adds.get(bone);
            const qW = add ? add.multiply(qBase) : qBase;
            this.worldQ.set(bone, qW);
            if (add) bone.setRotationQuaternion(qPA.conjugate().multiply(qW), BABYLON.Space.LOCAL);
        }
        this.bobY = this.grounded ? Math.abs(Math.sin(this.walkPhase)) * 0.03 * this.ampCur : 0;
    }
}

// =================================================================================================
//  FOOT IK — ступни читают поверхность (рейкасты) и держат контакт; BoneIKController на голени.
//  Идеи: ikSystem.js (raycast-поиск поверхности, pole target, lerp цели) + prototype support reading.
//  Вес IK автоматически снижается, когда стопа реально стоит на опоре (контакт подтверждён физикой),
//  и поднимается при рассогласовании анимации и рельефа — это часть логики смешения весов.
// =================================================================================================
class FootIK {
    constructor(cc) {
        this.cc = cc;
        this.targets = { left: null, right: null };
        this.controllers = { left: null, right: null };
        this.weights = { left: 0, right: 0 };
        this.smoothY = { left: null, right: null };
        this.enabled = false;
    }

    setup() {
        const cc = this.cc;
        // Создаём IK-цепочки только если они явно включены (options.ik.enabled либо params.ikEnabled)
        const ikOn = (cc.options.ik && cc.options.ik.enabled !== undefined)
            ? !!cc.options.ik.enabled : !!cc.params.ikEnabled;
        if (!ikOn) return;
        if (!cc.skinnedMesh || !cc.skelRef) return;
        for (const side of ['left', 'right']) {
            const footRef = cc.colliderRefs.find(r => r.isFootWeld && new RegExp(side === 'left' ? '_l|left' : '_r|right', 'i').test(r.name));
            if (!footRef) continue;
            const legRef = footRef.parentRef; // calf — родитель сваренной стопы
            if (!legRef || legRef.jt !== 'knee') continue;
            const target = new BABYLON.TransformNode(`cc_foot_target_${side}`, cc.scene);
            this.targets[side] = target;
            try {
                const ctrl = new BABYLON.BoneIKController(cc.skinnedMesh, legRef.bone, {
                    targetMesh: target,
                    poleTargetBone: legRef.parentRef ? legRef.parentRef.bone : legRef.bone,
                    poleAngle: 0,
                    bendAxis: new BABYLON.Vector3(1, 0, 0),
                    slerpAmount: cc.params.ikSlerp,
                });
                this.controllers[side] = ctrl;
                this.enabled = true;
            } catch (e) {
                console.warn('[CharacterController] FootIK не создан для', side, e);
            }
        }
    }

    update(dt) {
        const cc = this.cc, P = cc.params;
        if (!this.enabled) return;
        for (const side of ['left', 'right']) {
            const ctrl = this.controllers[side], target = this.targets[side];
            if (!ctrl || !target) continue;
            const footRef = cc.colliderRefs.find(r => r.isFootWeld && new RegExp(side === 'left' ? '_l|left' : '_r|right', 'i').test(r.name));
            const legRef = footRef ? footRef.parentRef : null;
            if (!legRef) continue;

            // Желаемая позиция стопы: физическая стопа, но Y скорректирован по рейкасту опоры
            let desiredWorld;
            try {
                desiredWorld = footRef.mesh.getAbsolutePosition().clone();
            } catch (_) { this.weights[side] = 0; ctrl.update(); continue; }

            const supY = cc.raycastSupportY(desiredWorld.x, desiredWorld.z, desiredWorld.y + 0.4);
            const grounded = footRef.groundContacts > 0;
            let weight = 0;
            if (supY !== null) {
                const gap = desiredWorld.y - supY;
                // Стопа «под землёй» или висит слишком низко относительно рельефа → корректируем
                if (gap < -0.02 || (grounded && Math.abs(gap) > P.footSupportTol)) {
                    weight = smoothstep(0.02, 0.15, Math.abs(gap));
                    desiredWorld.y = supY + P.ikFootLift;
                } else if (!grounded && cc.feetSupport.supported === 0 && cc.followingScale > 0.5) {
                    // Полностью в воздухе (прыжок/спуск) — тянем стопу к предполагаемой земле
                    weight = 0.5;
                    desiredWorld.y = supY + P.ikFootLift;
                }
            }
            // Смешение веса IK с общим following (в ragdoll IK не мешает физике)
            weight *= clampF(cc.followingScale, 0, 1);
            this.weights[side] = lerpF(this.weights[side], weight, Math.min(1, dt * 8));

            // Запись в local-space кости-родителя голенени (таз/спина) либо в мир через parent-node
            const anchor = legRef.parentRef ? legRef.parentRef.mesh : cc.rootRef.mesh;
            const invAnchor = anchor.getWorldMatrix().clone().invert();
            const desiredLocal = BABYLON.Vector3.TransformCoordinates(desiredWorld, invAnchor);
            target.parent = anchor;
            const k = clampF(this.weights[side], 0, 1);
            if (k > 0.01) {
                BABYLON.Vector3.LerpToRef(target.position, desiredLocal, k * Math.min(1, dt * 10) + 0.02, target.position);
            }
            try { ctrl.update(); } catch (_) {}
        }
    }

    dispose() {
        for (const s of ['left', 'right']) {
            try { this.controllers[s]?.dispose?.(); } catch (_) {}
            try { this.targets[s]?.dispose(); } catch (_) {}
        }
        this.controllers = { left: null, right: null };
        this.targets = { left: null, right: null };
        this.enabled = false;
    }
}

// =================================================================================================
//  CharacterController — публичный API
// =================================================================================================
export class CharacterController {
    /**
     * @param {BABYLON.Scene} scene
     * @param {{mesh,skeleton,animationGroups}} model — загруженный GLB-персонаж (скинет-меш)
     * @param {object} options { camera, params, supportPredicate, boneGroups, enableDrag, ik:{enabled},
     *                           hooks:{onImpact,onRagdoll,onGetUp}, masterVisible, masterAlpha }
     */
    constructor(scene, model, options = {}) {
        if (!scene || !model || !model.skeleton) throw new Error('CharacterController: нужны scene и модель со скелетом');
        this.scene = scene;
        this.skinnedMesh = model.mesh;
        this.skelRef = model.skeleton;
        this.animationGroups = model.animationGroups || [];
        this.camera = options.camera || scene.activeCamera;
        this.options = options;

        this.params = Object.assign({}, DEFAULT_PARAMS, options.params || {});
        this.boneGroups = options.boneGroups || DEFAULT_BONE_GROUPS;
        this.excludeBones = options.excludeBones || DEFAULT_EXCLUDE_BONES;
        this.hooks = options.hooks || {};

        this.physicsEngine = scene.getPhysicsEngine();
        if (!this.physicsEngine) throw new Error('CharacterController: физика не включена (scene.enablePhysics)');
        try { this.physicsEngine.setTimeStep(1 / 240, 8); }
        catch (_) { try { this.physicsEngine.setTimeStep(1 / 120, 8); } catch (_e) {} }

        this.supportPredicate = options.supportPredicate
            || (m => m.name === 'ground' || m.name.startsWith('obstacle_') || m.metadata?.tag === 'static');

        this.staticBodies = new Set(options.staticBodies || []);

        // Состояние мира ввода
        this.keys = new Set();
        this.externalIntent = null;         // {dir:Vector3, running:bool} — directive от AI
        this.externalSpeedLimit = null;     // idea from movement.js
        this.additionalMasterOffsets = null;// опциональные additive-позы (KRL-стиль)

        // Slave state
        this.colliderRefs = [];
        this.constraints = [];
        this.boneToRef = new Map();
        this.slaveBodyMap = new Map();
        this.rootRef = null;
        this.restLocalMatrix = new Map();

        // Weight system (см. WeightMixer ниже)
        this.followingScale = 1;
        this.staggerCoef = 1;
        this.staggerTimer = 0;
        this.globalStability = 1;
        this.ragdollCharge = 0;
        this.ragdollActive = false;         // падение (полный ragdoll)
        this.getUpProgress = 0;
        this.slaveAlive = true;
        this.slaveStrength = 1;
        this.forceCoefficient = 1;
        this.torqueCoefficient = 1;
        this.slaveStateTxt = 'FOLLOWING_ANIMATION';
        this.collisionCount = 0;
        this.limpWaveQueue = [];
        this.guardClamped = false;
        this.feetSupport = { supported: 0, total: 0, supportY: null };
        this.restRootAboveSupport = 0.9;
        this.followErrPos = 0;
        this.followErrRot = 0;

        // Drag (пружинный захват ЛКМ)
        this.dragEnabled = options.enableDrag !== false;
        this.dragState = null;

        this.balanceEnabled = true;
        this.reactionsEnabled = true;
        this.supportGuard = true;
        this.activeEnabled = true;

        this.master = new MasterController(this);
        this.footIK = new FootIK(this);

        this._observers = [];
        this._build();
    }

    // ------------------------------------------------------------------ сборка
    _build() {
        const scene = this.scene;
        this.LM = JointAxes.computeLandmarks(this.skelRef, this.skinnedMesh, this.excludeBones);

        // Мастер (полупрозрачный аватар-цель)
        this.master.create(this.skinnedMesh, this.skelRef, this.animationGroups, this.LM);

        // Рагдолл-слейв
        this._createRagdoll();

        // IK
        if (this.options.ik?.enabled !== false && this.params.ikEnabled) this.footIK.setup();

        // Коллизии → контакты/удары
        this._bindCollisions();
        // Ввод
        this._bindInput();

        // Главный цикл
        const syncObserver = scene.onBeforeRenderObservable.add(() => this._tick());
        this._observers.push(syncObserver);
    }

    _createRagdoll() {
        const scene = this.scene, mesh = this.skinnedMesh, skeleton = this.skelRef, P = this.params;
        mesh.computeWorldMatrix(true);

        this.restLocalMatrix.clear();
        for (const b of skeleton.bones) this.restLocalMatrix.set(b, b.getLocalMatrix().clone());

        const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        const matricesIndices = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesKind);
        const matricesWeights = mesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsKind);
        if (!positions || !matricesIndices || !matricesWeights) throw new Error('Нет скиннинга у меша');

        // Вершины принадлежат кости с максимальным весом (>0.5)
        const numVertices = positions.length / 3;
        const boneNameToIndex = {};
        skeleton.bones.forEach((b, i) => (boneNameToIndex[b.name] = i));
        const boneVertexIndices = Array.from({ length: skeleton.bones.length }, () => []);
        for (let i = 0; i < numVertices; i++) {
            let mw = matricesWeights[i * 4], mi = matricesIndices[i * 4];
            for (let k = 1; k < 4; k++) {
                if (matricesWeights[i * 4 + k] > mw) { mw = matricesWeights[i * 4 + k]; mi = matricesIndices[i * 4 + k]; }
            }
            if (mw > 0.5 && mi >= 0 && mi < skeleton.bones.length) boneVertexIndices[mi].push(i);
        }

        // Явные группы (таз/поясница/грудь…) + все прочие значимые кости
        const groups = [];
        const usedBones = new Set();
        for (const gName of Object.keys(this.boneGroups)) {
            const boneNames = this.boneGroups[gName];
            const idxs = [], brefs = [];
            let valid = false;
            for (const nm of boneNames) {
                const ix = boneNameToIndex[nm];
                if (ix === undefined) continue;
                valid = true;
                usedBones.add(ix);
                brefs.push(skeleton.bones[ix]);
                for (const vi of boneVertexIndices[ix]) idxs.push(vi);
            }
            if (!valid || idxs.length < 4) continue;
            groups.push({ name: gName, vertexIndices: [...new Set(idxs)], primaryBone: brefs[0], boneNames: brefs.map(b => b.name).join('+') });
        }
        for (let i = 0; i < skeleton.bones.length; i++) {
            const bn = skeleton.bones[i].name;
            if (usedBones.has(i) || this.excludeBones.includes(bn) || SKIP_RE.test(bn)) continue;
            if (boneVertexIndices[i].length < 4) continue;
            groups.push({ name: bn, vertexIndices: boneVertexIndices[i], primaryBone: skeleton.bones[i], boneNames: bn });
        }

        const masterBoneByName = new Map();
        if (this.master.skeleton) for (const b of this.master.skeleton.bones) masterBoneByName.set(b.name, b);

        const tmpV = new BABYLON.Vector3();
        for (const group of groups) {
            const bone = group.primaryBone;
            const invBind = bone.getAbsoluteInverseBindMatrix();
            let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (const vi of group.vertexIndices) {
                tmpV.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
                BABYLON.Vector3.TransformCoordinatesToRef(tmpV, invBind, tmpV);
                if (tmpV.x < minX) minX = tmpV.x; if (tmpV.y < minY) minY = tmpV.y; if (tmpV.z < minZ) minZ = tmpV.z;
                if (tmpV.x > maxX) maxX = tmpV.x; if (tmpV.y > maxY) maxY = tmpV.y; if (tmpV.z > maxZ) maxZ = tmpV.z;
            }
            const size = new BABYLON.Vector3(maxX - minX, maxY - minY, maxZ - minZ);
            const center = new BABYLON.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
            if (size.lengthSquared() < 0.0005) continue;

            const boneWorld = BABYLON.Matrix.Invert(invBind);
            const centerWorld = BABYLON.Vector3.TransformCoordinates(center, boneWorld);
            let boneWorldRot = null;
            try { boneWorldRot = bone.getRotationQuaternion(BABYLON.Space.WORLD, mesh); } catch (_) {}
            if (!boneWorldRot) boneWorldRot = BABYLON.Quaternion.FromRotationMatrix(boneWorld.getRotationMatrix());

            const isWelded = WELD_RE.test(group.name);
            const box = BABYLON.MeshBuilder.CreateBox('col_' + group.name, { width: size.x, height: size.y, depth: size.z }, scene);
            box.position.copyFrom(centerWorld);
            box.rotationQuaternion = boneWorldRot.clone();
            box.computeWorldMatrix(true);
            box.visibility = this.options.showColliders === false ? 0 : 0.3;
            const mat = new BABYLON.StandardMaterial('cm_' + group.name, scene);
            mat.diffuseColor = isWelded ? new BABYLON.Color3(1.0, 0.7, 0.3) : new BABYLON.Color3(0.2, 0.8, 1.0);
            mat.alpha = 0.35;
            box.material = mat;

            const colName = classifyGroup(group.name);
            const isFootWeld = isWelded && /foot|ball/.test(group.name);
            const agg = new BABYLON.PhysicsAggregate(box, BABYLON.PhysicsShapeType.BOX, {
                mass: massFor(group.name), restitution: 0,
                friction: isFootWeld ? 1.6 : 0.85,
                linearDamping: P.linDamp, angularDamping: P.angDamp,
                collisionGroup: COL_GROUP[colName],
                collisionMask: COL_MASK[colName] !== undefined ? COL_MASK[colName] : ~0,
            }, scene);
            agg.body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
            try { agg.body.setMaxLinearVelocity(18); agg.body.setMaxAngularVelocity(45); } catch (_) {}

            const jt = isWelded ? 'weld' : jointTypeFor(group.name);
            const ref = {
                mesh: box, agg, bone, masterBone: masterBoneByName.get(bone.name) || null,
                name: group.name, boneNames: group.boneNames,
                bindCenter: center, boxSize: size.clone(),
                isRoot: false, parentRef: null, jt, isWelded, isFootWeld, children: [],
                fProfile: forceProfileFor(jt), tProfile: torqueProfileFor(jt),
                effF: forceProfileFor(jt), effT: torqueProfileFor(jt),
                lastTargetCOM: null, lastMRot: null, trackErrMag: 0,
                groundContacts: 0, savedLinkedNode: null,
                limp: 0, flashTimer: 0, baseEmissive: new BABYLON.Color3(0, 0, 0),
                stress: 0, driveStress: 0, prevVel: BABYLON.Vector3.Zero(),
            };
            this.colliderRefs.push(ref);
            this.boneToRef.set(bone, ref);
            this.slaveBodyMap.set(agg.body, ref);
        }

        // Отвязываем кости от их трансформ-нодов (кости будут управляться скининг-синком)
        for (const ref of this.colliderRefs) {
            const tn = ref.bone.getTransformNode();
            if (tn) { ref.savedLinkedNode = tn; ref.bone.linkTransformNode(null); }
        }

        // Корень — самая мелкая кость по глубине
        const depthOf = b => { let d = 0, pp = b.getParent(); while (pp) { d++; pp = pp.getParent(); } return d; };
        for (const r of this.colliderRefs) {
            if (!this.rootRef || depthOf(r.bone) < depthOf(this.rootRef.bone)) this.rootRef = r;
        }
        if (this.rootRef) {
            this.rootRef.isRoot = true;
            this.pelvisOffset = this.rootRef.bone.getAbsolutePosition(mesh).subtract(mesh.position);
            this.restPelvisY = this.rootRef.mesh.getAbsolutePosition().y;
        }

        // rest-высота таза над низом стоп — «потолок» подъёма для охраны опоры
        let feetBottom = Infinity;
        for (const ref of this.colliderRefs) {
            if (!ref.isFootWeld) continue;
            try {
                const bb = ref.mesh.getBoundingInfo().boundingBox;
                if (bb.minimumWorld.y < feetBottom) feetBottom = bb.minimumWorld.y;
            } catch (_) {}
        }
        if (!isFinite(feetBottom)) feetBottom = 0;
        this.restRootAboveSupport = Math.max(0.2, this.restPelvisY - feetBottom);

        // Суставы: weld (locked 6DOF) или анатомические лимиты
        const LOCKED_6DOF = () => ([
            { axis: BABYLON.PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
            { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
            { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
            { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_X, minLimit: 0, maxLimit: 0 },
            { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Y, minLimit: 0, maxLimit: 0 },
            { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Z, minLimit: 0, maxLimit: 0 },
        ]);
        for (const ref of this.colliderRefs) {
            let pb = ref.bone.getParent();
            let parentRef = null;
            while (pb) {
                parentRef = this.boneToRef.get(pb) || this.colliderRefs.find(r => r.boneNames && r.boneNames.split('+').includes(pb.name));
                if (parentRef) break;
                pb = pb.getParent();
            }
            if (!parentRef) parentRef = this.rootRef;
            if (!parentRef || parentRef === ref) continue;
            ref.parentRef = parentRef;
            parentRef.children.push(ref);

            const jointWorld = ref.bone.getAbsolutePosition(mesh);
            const invP = BABYLON.Matrix.Invert(parentRef.mesh.getWorldMatrix());
            const invC = BABYLON.Matrix.Invert(ref.mesh.getWorldMatrix());
            const pivotA = BABYLON.Vector3.TransformCoordinates(jointWorld, invP);
            const pivotB = BABYLON.Vector3.TransformCoordinates(jointWorld, invC);
            const common = {
                pivotA, pivotB,
                axisA: BABYLON.Vector3.TransformNormal(BABYLON.Axis.X, invP).normalize(),
                axisB: BABYLON.Vector3.TransformNormal(BABYLON.Axis.X, invC).normalize(),
                perpAxisA: BABYLON.Vector3.TransformNormal(BABYLON.Axis.Y, invP).normalize(),
                perpAxisB: BABYLON.Vector3.TransformNormal(BABYLON.Axis.Y, invC).normalize(),
                parentIsFirst: true,
            };

            if (ref.isWelded) {
                const con = new BABYLON.Physics6DoFConstraint(common, LOCKED_6DOF(), this.scene);
                parentRef.agg.body.addConstraint(ref.agg.body, con);
                try { con.isCollisionsEnabled = false; } catch (_) {}
                this.constraints.push(con);
                continue;
            }

            const axes = JointAxes.build(ref, this.LM, mesh, this.excludeBones);
            ref.jt = axes.jt;
            const lim = axes.lim;
            const con = new BABYLON.Physics6DoFConstraint({
                ...common,
                axisA: BABYLON.Vector3.TransformNormal(axes.Xw, invP).normalize(),
                axisB: BABYLON.Vector3.TransformNormal(axes.Xw, invC).normalize(),
                perpAxisA: BABYLON.Vector3.TransformNormal(axes.Yw, invP).normalize(),
                perpAxisB: BABYLON.Vector3.TransformNormal(axes.Yw, invC).normalize(),
            }, [
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
                { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_X, minLimit: lim.X[0] * D2R, maxLimit: lim.X[1] * D2R },
                { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Y, minLimit: lim.Y[0] * D2R, maxLimit: lim.Y[1] * D2R },
                { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Z, minLimit: (lim.Z ? lim.Z[0] : -15) * D2R, maxLimit: (lim.Z ? lim.Z[1] : 15) * D2R },
            ], this.scene);
            parentRef.agg.body.addConstraint(ref.agg.body, con);
            try { con.isCollisionsEnabled = false; } catch (_) {}
            this.constraints.push(con);
        }
    }

    _bindCollisions() {
        const CET = BABYLON.PhysicsCollisionEventType;
        if (!CET) return;
        const obs = this.physicsEngine.onCollisionObservable.add(ev => {
            if (!this.slaveBodyMap.size) return;
            const started = ev.type === CET.STARTED;
            const ended = ev.type === CET.ENDED;
            if (!started && !ended) return;
            const d = started ? 1 : -1;
            const ra = this.slaveBodyMap.get(ev.bodyA);
            const rb = this.slaveBodyMap.get(ev.bodyB);
            if (ra) {
                this.collisionCount = Math.max(0, this.collisionCount + d);
                if (this._isStatic(ev.bodyB)) ra.groundContacts = Math.max(0, (ra.groundContacts || 0) + d);
            }
            if (rb) {
                this.collisionCount = Math.max(0, this.collisionCount + d);
                if (this._isStatic(ev.bodyA)) rb.groundContacts = Math.max(0, (rb.groundContacts || 0) + d);
            }
            if (started) {
                this._processCollisionImpact(ra);
                this._processCollisionImpact(rb);
            }
        });
        this._observers.push(obs);
    }

    _isStatic(body) {
        if (this.staticBodies.has(body)) return true;
        try { return body.getMotionType() === BABYLON.PhysicsMotionType.STATIC; } catch (_) { return false; }
    }

    _bindInput() {
        this._onKeyDown = (e) => { this.keys.add(e.code); if (e.key === 'Escape') this.endDrag(); };
        this._onKeyUp = (e) => this.keys.delete(e.code);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);

        if (this.dragEnabled) {
            const canvas = this.scene.getEngine().getRenderingCanvas();
            this._onPointerDown = (evt) => this._beginDrag(evt);
            this._onPointerUp = () => this.endDrag();
            canvas.addEventListener('pointerdown', this._onPointerDown);
            window.addEventListener('pointerup', this._onPointerUp);
        }
    }

    // ------------------------------------------------------------------ чтение опоры
    raycastSupportY(x, z, fromY) {
        const ray = new BABYLON.Ray(new BABYLON.Vector3(x, fromY, z), new BABYLON.Vector3(0, -1, 0), 10);
        const hit = this.scene.pickWithRay(ray, this.supportPredicate);
        return (hit && hit.hit && hit.pickedPoint) ? hit.pickedPoint.y : null;
    }

    getFeetSupport() {
        let supported = 0, total = 0, bestY = -Infinity;
        const P = this.params;
        for (const ref of this.colliderRefs) {
            if (!ref.isFootWeld) continue;
            total++;
            let bb;
            try { bb = ref.mesh.getBoundingInfo().boundingBox; } catch (_) { continue; }
            const bottomY = bb.minimumWorld.y;
            const cx = bb.centerWorld.x, cz = bb.centerWorld.z;
            const contact = ref.groundContacts > 0;
            const supY = this.raycastSupportY(cx, cz, bottomY + 0.4);
            const near = (supY !== null) && (bottomY - supY < P.footSupportTol);
            if (contact || near) {
                supported++;
                const y = (supY !== null) ? supY : bottomY;
                if (y > bestY) bestY = y;
            }
        }
        return { supported, total, supportY: isFinite(bestY) ? bestY : null };
    }

    // ------------------------------------------------------------------ реакции на удары
    _processCollisionImpact(r) {
        if (!r || !this.reactionsEnabled) return;
        let vNow = BABYLON.Vector3.Zero();
        try { vNow = r.agg.body.getLinearVelocity(); } catch (_) {}
        const dv = vNow.subtract(r.prevVel); // Δv за шаг физики = импульс/m контакта
        const severity = dv.length();
        const dir = severity > 1e-5 ? dv.scale(1 / severity) : new BABYLON.Vector3(0, 1, 0);
        this.triggerHitReaction(r, severity, dir);
    }

    triggerHitReaction(ref, severity, hitDir) {
        const P = this.params;
        if (!this.reactionsEnabled || !ref) return;
        if (severity < P.reactMinSev) return;
        if (ref.isFootWeld && severity < 4) return; // постоянный контакт ног — не «удар»

        let mass = 1; try { mass = ref.agg.body.getMass() || 1; } catch (_) {}
        const impulseJ = mass * severity;

        const limpAmount = clampF(severity * 0.2, 0.15, 1.0);
        ref.limp = Math.min(1, ref.limp + limpAmount);
        ref.flashTimer = 0.5;
        ref.stress = Math.min(1, ref.stress + clampF(severity * 0.15, 0, 0.8));
        try { ref.mesh.material.emissiveColor = new BABYLON.Color3(0.95, 0.25, 0.1); } catch (_) {}

        // Физическое «дожимание» удара
        const extraImpulse = clampF(severity * 0.35, 0.3, 3.5);
        try { ref.agg.body.applyImpulse(hitDir.scale(extraImpulse * mass), ref.mesh.getAbsolutePosition()); } catch (_) {}

        // Волна limp/stress по соседям (родитель/дети, затухание с глубиной)
        const neighbors = [];
        if (ref.parentRef) neighbors.push({ ref: ref.parentRef, depth: 1 });
        for (const ch of ref.children) neighbors.push({ ref: ch, depth: 1 });
        for (const nb of neighbors) {
            const amount = limpAmount * P.waveStrength * Math.pow(0.55, nb.depth - 1);
            if (amount > 0.03) this.limpWaveQueue.push({ ref: nb.ref, timer: P.waveDelay * nb.depth, limpAmount: amount, stressAmount: amount * 0.4 });
            const nextNeighbors = [];
            if (nb.ref.parentRef && nb.ref.parentRef !== ref) nextNeighbors.push({ ref: nb.ref.parentRef, depth: nb.depth + 1 });
            for (const ch of nb.ref.children) if (ch !== ref) nextNeighbors.push({ ref: ch, depth: nb.depth + 1 });
            for (const nn of nextNeighbors) {
                const amount2 = limpAmount * P.waveStrength * Math.pow(0.55, nn.depth - 1);
                if (amount2 > 0.03) this.limpWaveQueue.push({ ref: nn.ref, timer: P.waveDelay * nn.depth, limpAmount: amount2, stressAmount: amount2 * 0.25 });
            }
        }

        // Stagger (оглушение) — сильный или в корень/позвоночник
        const isCore = ref.isRoot || ref.jt === 'spine';
        if (severity > 3 || isCore) {
            const staggerImpulse = P.staggerForce * clampF(severity / 10, 0.2, 1.5);
            if (this.rootRef && this.rootRef !== ref) {
                let rootMass = 1; try { rootMass = this.rootRef.agg.body.getMass() || 1; } catch (_) {}
                try { this.rootRef.agg.body.applyImpulse(hitDir.scale(staggerImpulse * rootMass * 0.3), this.rootRef.mesh.getAbsolutePosition()); } catch (_) {}
            }
            this.staggerTimer = Math.max(this.staggerTimer, clampF(severity * 0.2, 0.2, 1.5));
        }

        // Рефлекс головы
        if (severity > 4 || isCore) {
            const headRef = this.colliderRefs.find(r => /head/i.test(r.name) && !/neck/i.test(r.name));
            if (headRef && headRef !== ref) {
                let hm = 1; try { hm = headRef.agg.body.getMass() || 1; } catch (_) {}
                const headImpulse = clampF(severity * 0.5, 0.4, 3.5);
                try { headRef.agg.body.applyImpulse(hitDir.scale(headImpulse * hm), headRef.mesh.getAbsolutePosition()); } catch (_) {}
                headRef.limp = Math.min(1, headRef.limp + 0.35);
                headRef.stress = Math.min(1, headRef.stress + 0.4);
            }
        }

        if (this.hooks.onImpact) this.hooks.onImpact({ zone: classifyGroup(ref.name), severity, impulseJ, bone: ref.name, direction: hitDir });
    }

    _updateReactions(dt) {
        const P = this.params;
        for (let i = this.limpWaveQueue.length - 1; i >= 0; i--) {
            const w = this.limpWaveQueue[i];
            w.timer -= dt;
            if (w.timer <= 0) {
                w.ref.limp = Math.min(1, w.ref.limp + w.limpAmount);
                w.ref.stress = Math.min(1, w.ref.stress + w.stressAmount);
                this.limpWaveQueue.splice(i, 1);
            }
        }
        if (this.staggerTimer > 0) this.staggerTimer = Math.max(0, this.staggerTimer - dt);
        const targetStagger = this.staggerTimer > 0 ? 0.25 : 1.0;
        this.staggerCoef = lerpF(this.staggerCoef, targetStagger, clampF(4 * dt, 0, 1));
        for (const ref of this.colliderRefs) {
            if (ref.limp > 0) ref.limp = Math.max(0, ref.limp - P.recoveryRate * dt);
            if (ref.flashTimer > 0) {
                ref.flashTimer -= dt;
                if (ref.flashTimer <= 0) { try { ref.mesh.material.emissiveColor.copyFrom(ref.baseEmissive); } catch (_) {} }
            }
        }
    }

    // ------------------------------------------------------------------ LOGIC OF MIXING WEIGHTS
    /*
     * Единый каскад весов, перемножающихся на выход PD-привода:
     *
     *   finalPosGain = followingScale × staggerCoef × forceCoefficient × effF(ref)
     *   finalAngGain = followingScale × staggerCoef × torqueCoefficient × effT(ref)
     *
     *  где:
     *   • followingScale ∈ [0..1] — глобальный «вес следования», управляется стабильностью и
     *     ragdoll-машиной состояний (0 = чистый ragdoll, 1 = полная марионетка).
     *   • staggerCoef — временное оглушение от ударов (0.25 во время stagger).
     *   • force/torqueCoefficient — «сила духа» слейва: LOOSING при активных контактах,
     *     GAINING в покое; DEAD → 0, затем оживление через deadTime.
     *   • effF/effT = профиль сустава × limp-фактор × stress-фактор — локальное ослабление конечностей.
     */
    _updateStability(dt) {
        const P = this.params;
        const computeEff = (useStress) => {
            for (const ref of this.colliderRefs) {
                const limpFactor = 1 - ref.limp * 0.85;
                const stressFactor = useStress ? (1 - ref.stress * P.stressWeakenAmount) : 1.0;
                ref.effF = ref.fProfile * limpFactor * stressFactor;
                ref.effT = ref.tProfile * limpFactor * stressFactor;
            }
        };

        if (!this.activeEnabled || !this.slaveAlive || !this.rootRef || !this.colliderRefs.length) {
            this.followingScale = lerpF(this.followingScale, this.slaveAlive ? 1 : 0, clampF(3 * dt, 0, 1));
            computeEff(false);
            return;
        }

        // Drive-stress: сопротивление привода перегрузке (большая ошибка слежения на опоре)
        for (const ref of this.colliderRefs) {
            if (ref.limp > 0.3) { ref.driveStress = 0; continue; }
            const limbSize = Math.max(0.12, ref.boxSize.length());
            const normErr = ref.trackErrMag / limbSize;
            let drive = 0;
            if (normErr > 0.6) drive = clampF((normErr - 0.6) * 1.6, 0, 1);
            if (ref.groundContacts > 0 && normErr > 0.4) drive = Math.max(drive, 0.5);
            ref.driveStress = drive;
        }

        // Диффузия стресса по иерархии (соседи получают долю, с распадом)
        const targets = new Map();
        for (const ref of this.colliderRefs) {
            let neigh = 0;
            if (ref.parentRef) neigh = Math.max(neigh, ref.parentRef.stress);
            for (const ch of ref.children) neigh = Math.max(neigh, ch.stress);
            targets.set(ref, Math.max(ref.driveStress, neigh * P.stressSpread));
        }
        for (const ref of this.colliderRefs) {
            const tgt = targets.get(ref);
            const decayed = Math.max(0, ref.stress - P.stressDecayRate * dt);
            ref.stress = lerpF(decayed, tgt, clampF(P.stressFlowRate * dt, 0, 1));
            if (ref.stress < 0.01) ref.stress = 0;
        }

        // Глобальная стабильность: стресс + смещение ЦМ от опоры + наклон таза
        let sumStress = 0;
        for (const ref of this.colliderRefs) sumStress += ref.stress;
        const avgStress = sumStress / this.colliderRefs.length;

        let totalMass = 0; const com = BABYLON.Vector3.Zero();
        for (const ref of this.colliderRefs) {
            let m = 1; try { m = ref.agg.body.getMass() || 1; } catch (_) {}
            com.addInPlace(ref.mesh.getAbsolutePosition().scale(m)); totalMass += m;
        }
        if (totalMass > 0) com.scaleInPlace(1 / totalMass);
        let nG = 0; const sup = BABYLON.Vector3.Zero();
        for (const ref of this.colliderRefs) { if (ref.groundContacts > 0) { sup.addInPlace(ref.mesh.getAbsolutePosition()); nG++; } }
        let comOff = 0;
        if (nG > 0) { sup.scaleInPlace(1 / nG); comOff = Math.hypot(com.x - sup.x, com.z - sup.z); }
        const pelvisQ = this.rootRef.mesh.absoluteRotationQuaternion || BABYLON.Quaternion.Identity();
        const pelvisUp = rotateVecByQuat(new BABYLON.Vector3(0, 1, 0), pelvisQ);
        const pelvisTilt = clampF(1 - pelvisUp.y, 0, 1);
        const comOffNorm = clampF(comOff / 0.5, 0, 1);

        let rawStability = 1 - clampF(0.5 * avgStress + 0.25 * comOffNorm + 0.45 * pelvisTilt, 0, 1);
        if (nG === 0) rawStability *= 0.7;
        this.globalStability = lerpF(this.globalStability, rawStability, clampF(3 * dt, 0, 1));

        // Ragdoll-машина состояний с гистерезисом (FALLING ↔ RECOVERING)
        if (this.globalStability < P.stabilityDropThreshold) {
            this.ragdollCharge += dt;
            if (this.ragdollCharge > P.ragdollDropDelay && !this.ragdollActive) {
                this.ragdollActive = true;
                this.getUpProgress = 0;
                if (this.hooks.onRagdoll) this.hooks.onRagdoll({ cause: 'stability', stability: this.globalStability });
            }
        } else {
            this.ragdollCharge = Math.max(0, this.ragdollCharge - dt * 2);
            if (this.globalStability > P.stabilityRecoverThreshold && this.ragdollActive) {
                // Плавный get-up: вес следования возвращается медленно (аналог GetUpState)
                this.getUpProgress += dt * 0.7;
                if (this.getUpProgress >= 1) {
                    this.ragdollActive = false;
                    this.getUpProgress = 0;
                    if (this.hooks.onGetUp) this.hooks.onGetUp();
                }
            } else if (!this.ragdollActive) {
                this.getUpProgress = 0;
            }
        }

        if (this.ragdollActive) {
            this.followingScale = lerpF(this.followingScale, 0, clampF(5 * dt, 0, 1));
        } else {
            const tgtScale = clampF(this.globalStability, 0, 1);
            this.followingScale = lerpF(this.followingScale, Math.max(tgtScale, 0.15), clampF(1.0 * dt, 0, 1));
        }

        computeEff(true);

        // Визуализация стресса (emissive), если нет активного хита/дрэга
        for (const ref of this.colliderRefs) {
            if (ref.flashTimer <= 0 && !(this.dragState && this.dragState.ref === ref)) {
                if (ref.stress > 0.05 || ref.limp > 0.05) {
                    const intensity = Math.max(ref.stress, ref.limp);
                    try { ref.mesh.material.emissiveColor = new BABYLON.Color3(0.7 * intensity, 0.18 * intensity, 0.05 * intensity); } catch (_) {}
                } else {
                    try { ref.mesh.material.emissiveColor.copyFrom(ref.baseEmissive); } catch (_) {}
                }
            }
        }
    }

    _updateSlaveController(dt) {
        const P = this.params;
        if (!this.slaveAlive) {
            this.slaveStateTxt = 'DEAD';
            this.forceCoefficient = 0;
            this.torqueCoefficient = 0;
            this.slaveDeadStep = (this.slaveDeadStep || 0) + dt;
            if (this.slaveDeadStep >= P.deadTime) this.comeAlive();
            return;
        }
        if (this.collisionCount > 0) this.slaveStateTxt = 'LOOSING_STRENGTH';
        else if (this.slaveStrength < 1) this.slaveStateTxt = 'GAINING_STRENGTH';
        else this.slaveStateTxt = 'FOLLOWING_ANIMATION';

        if (this.slaveStateTxt === 'LOOSING_STRENGTH') this.slaveStrength = clampF(this.slaveStrength - P.looseStrengthLerp * dt, 0, 1);
        else if (this.slaveStateTxt === 'GAINING_STRENGTH') this.slaveStrength = clampF(this.slaveStrength + P.gainStrengthLerp * dt, 0, 1);

        this.forceCoefficient = lerpF(P.minContactForce, 1, this.slaveStrength);
        this.torqueCoefficient = lerpF(P.minContactTorque, 1, this.slaveStrength);
    }

    // ------------------------------------------------------------------ BALANCE (ЦМ над опорой)
    _applyBalance(dt) {
        const P = this.params;
        if (!this.balanceEnabled || !this.slaveAlive || !this.rootRef || !this.colliderRefs.length) return;
        if (this.dragState) return;
        if (dt <= 0) return;
        if (this.staggerTimer > 0) return;
        if (this.ragdollActive) return;

        const rootBody = this.rootRef.agg.body;
        const pelvisQ = this.rootRef.mesh.absoluteRotationQuaternion || BABYLON.Quaternion.Identity();
        const pelvisUp = rotateVecByQuat(new BABYLON.Vector3(0, 1, 0), pelvisQ);
        if (pelvisUp.y < 0.4) return;

        let totalMass = 0;
        const com = BABYLON.Vector3.Zero();
        for (const ref of this.colliderRefs) {
            let m = 1; try { m = ref.agg.body.getMass() || 1; } catch (_) {}
            com.addInPlace(ref.mesh.getAbsolutePosition().scale(m));
            totalMass += m;
        }
        if (totalMass <= 0) return;
        com.scaleInPlace(1 / totalMass);

        let nG = 0;
        const sup = BABYLON.Vector3.Zero();
        for (const ref of this.colliderRefs) {
            if (ref.groundContacts > 0) { sup.addInPlace(ref.mesh.getAbsolutePosition()); nG++; }
        }
        if (nG === 0) return;
        sup.scaleInPlace(1 / nG);

        const errX = com.x - sup.x, errZ = com.z - sup.z;
        let rv = BABYLON.Vector3.Zero();
        try { rv = rootBody.getLinearVelocity(); } catch (_) {}
        let rm = 1; try { rm = rootBody.getMass() || 1; } catch (_) {}
        let fx = -P.KpBal * errX - P.KdBal * rv.x;
        let fz = -P.KpBal * errZ - P.KdBal * rv.z;
        const fmax = P.maxBalForce * rm;
        const fmag = Math.hypot(fx, fz);
        if (fmag > fmax) { fx *= fmax / fmag; fz *= fmax / fmag; }
        try {
            rootBody.applyImpulse(new BABYLON.Vector3(fx, 0, fz).scale(rm * dt), this.rootRef.mesh.getAbsolutePosition());
            rootBody.wakeUp();
        } catch (_) {}

        // Вертикализация таза (PD по up-вектору)
        const upErr = BABYLON.Vector3.Cross(pelvisUp, new BABYLON.Vector3(0, 1, 0));
        let w = BABYLON.Vector3.Zero();
        try { w = rootBody.getAngularVelocity(); } catch (_) {}
        const torque = upErr.scale(P.KpUpright).subtract(w.scale(P.KdUpright));
        const bs = this.rootRef.boxSize;
        const I = rm / 12 * (bs.y * bs.y + bs.z * bs.z);
        try { rootBody.applyTorqueImpulse(torque.scale(I * dt)); } catch (_) {}
    }

    // ------------------------------------------------------------------ FOLLOW (PD-приводы к мастеру)
    _followAnimation(dt) {
        const P = this.params;
        if (!this.colliderRefs.length || !this.master.mesh || dt <= 0) return;
        if (!this.slaveAlive) return;

        const mScale = this.master.mesh.scaling.x || 1;
        const kdPos = 2 * P.zetaPos * Math.sqrt(Math.max(1, P.KpPos));
        const kdAngBase = 2 * P.zetaAng * Math.sqrt(Math.max(1, P.KpAng));
        let sumP = 0, sumR = 0, n = 0;

        for (const ref of this.colliderRefs) {
            if (this.dragState && this.dragState.ref === ref) continue;
            if (!ref.masterBone) continue;
            const body = ref.agg.body;

            let mPos, mRot;
            try {
                mPos = ref.masterBone.getAbsolutePosition(this.master.mesh);
                mRot = ref.masterBone.getRotationQuaternion(BABYLON.Space.WORLD, this.master.mesh);
            } catch (_) { continue; }
            if (!mRot) continue;

            const grounded = ref.groundContacts > 0;
            const passiveWeld = ref.isWelded && grounded && ref.isFootWeld; // стопа на опоре — не дёргаем

            const off = rotateVecByQuat(ref.bindCenter.scale(mScale), mRot);
            const targetCOM = mPos.add(off);
            const slaveCOM = ref.mesh.getAbsolutePosition();
            const err = targetCOM.subtract(slaveCOM);
            ref.trackErrMag = err.length();

            if (!passiveWeld) {
                let vS = BABYLON.Vector3.Zero();
                try { vS = body.getLinearVelocity(); } catch (_) {}
                let vM = BABYLON.Vector3.Zero();
                if (ref.lastTargetCOM && dt > 1e-5) vM = targetCOM.subtract(ref.lastTargetCOM).scale(1 / dt);
                ref.lastTargetCOM = targetCOM.clone();

                const vRel = vS.subtract(vM);
                const acc = err.scale(P.KpPos).subtract(vRel.scale(kdPos));
                // === каскад весов (линейная ось) ===
                const aMax = P.maxAccel * ref.effF * this.forceCoefficient * this.staggerCoef * this.followingScale;
                const aLen = acc.length();
                if (aLen > aMax) acc.scaleInPlace(aMax / aLen);

                let mass = 1;
                try { mass = body.getMass() || 1; } catch (_) {}
                try { body.applyImpulse(acc.scale(mass * dt), slaveCOM); body.wakeUp(); } catch (_) {}
                sumP += err.length(); n++;
            } else {
                ref.lastTargetCOM = targetCOM.clone();
            }

            // === каскад весов (угловая ось) ===
            {
                const qCur = ref.mesh.absoluteRotationQuaternion || ref.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();
                let qErr = qCur.conjugate().multiply(mRot);
                if (qErr.w < 0) qErr = qErr.scale(-1);
                const rvL = quatToRotVec(qErr);

                let wmW = BABYLON.Vector3.Zero();
                if (ref.lastMRot && dt > 1e-5) {
                    let qd = mRot.multiply(ref.lastMRot.conjugate());
                    if (qd.w < 0) qd = qd.scale(-1);
                    wmW = quatToRotVec(qd).scale(1 / dt);
                }
                ref.lastMRot = mRot.clone();

                const qInv = qCur.conjugate();
                let wS = BABYLON.Vector3.Zero();
                try { wS = body.getAngularVelocity(); } catch (_) {}
                const wRelL = rotateVecByQuat(wS, qInv).subtract(rotateVecByQuat(wmW, qInv));

                let mass = 1;
                try { mass = body.getMass() || 1; } catch (_) {}
                const sx = ref.boxSize.x, sy = ref.boxSize.y, sz = ref.boxSize.z;
                const ix = mass / 12 * (sy * sy + sz * sz);
                const iy = mass / 12 * (sx * sx + sz * sz);
                const iz = mass / 12 * (sx * sx + sy * sy);

                const kpEff = P.KpAng * this.torqueCoefficient * this.staggerCoef * this.followingScale * ref.effT;
                const kdEff = kdAngBase * ref.effT;

                let ax = clampF(kpEff * rvL.x - kdEff * wRelL.x, -P.ANG_ACC_MAX, P.ANG_ACC_MAX);
                let ay = clampF(kpEff * rvL.y - kdEff * wRelL.y, -P.ANG_ACC_MAX, P.ANG_ACC_MAX);
                let az = clampF(kpEff * rvL.z - kdEff * wRelL.z, -P.ANG_ACC_MAX, P.ANG_ACC_MAX);

                const L = new BABYLON.Vector3(ix * ax * dt, iy * ay * dt, iz * az * dt);
                const Lmax = P.maxJointTorque * ref.effT * Math.max(this.torqueCoefficient * this.staggerCoef * this.followingScale, 0.05) * dt;
                const Ll = L.length();
                if (Ll > Lmax) L.scaleInPlace(Lmax / Ll);

                const Lw = rotateVecByQuat(L, qCur);
                let applied = false;
                try { body.applyTorqueImpulse(Lw); applied = true; } catch (_) {}
                if (!applied) { try { body.applyTorque(Lw.scale(1 / dt)); } catch (_) {} }

                sumR += rvL.length() / D2R;
            }
        }
        this.followErrPos = n ? (sumP / n) * 100 : 0;
        this.followErrRot = n ? sumR / n : 0;
    }

    // ------------------------------------------------------------------ SKINNING SYNC
    _syncSkinning() {
        const mesh = this.skinnedMesh, skel = this.skelRef;
        if (!mesh || !skel || !this.rootRef) return;
        const decS = new BABYLON.Vector3(), decQ = new BABYLON.Quaternion(), decP = new BABYLON.Vector3();

        const rootBox = this.rootRef.mesh;
        const boxRot = rootBox.getWorldMatrix().getRotationMatrix();
        const cOff = BABYLON.Vector3.TransformNormal(this.rootRef.bindCenter, boxRot);
        mesh.position.copyFrom(rootBox.getAbsolutePosition().subtract(cOff).subtract(this.pelvisOffset));
        mesh.computeWorldMatrix(true);

        const meshPos = mesh.position;
        const oneOverS = 1 / (mesh.scaling.x || 1);
        const tracked = new Map();
        for (const bone of skel.bones) {
            const parent = bone.getParent();
            const Pm = parent ? tracked.get(parent) : null;
            const ref = this.boneToRef.get(bone);
            if (ref) {
                const bw = ref.mesh.getWorldMatrix();
                const off = BABYLON.Vector3.TransformNormal(ref.bindCenter, bw.getRotationMatrix());
                const pW = ref.mesh.getAbsolutePosition().subtract(off);
                const tPos = pW.subtract(meshPos).scaleInPlace(oneOverS);
                const T = BABYLON.Matrix.ComposeToRef(
                    BABYLON.Vector3.One(),
                    ref.mesh.absoluteRotationQuaternion || BABYLON.Quaternion.Identity(),
                    tPos,
                    new BABYLON.Matrix()
                );
                let Lm;
                if (Pm) { const iP = Pm.clone(); iP.invert(); Lm = T.clone().multiply(iP); }
                else Lm = T.clone();
                Lm.decompose(decS, decQ, decP);
                bone.position = decP;
                bone.setRotationQuaternion(decQ, BABYLON.Space.LOCAL);
                tracked.set(bone, T);
            } else {
                const rest = this.restLocalMatrix.get(bone);
                const W = (Pm && rest) ? rest.clone().multiply(Pm) : (rest ? rest.clone() : BABYLON.Matrix.Identity());
                tracked.set(bone, W);
            }
        }
        mesh.computeWorldMatrix(true);
    }

    // ------------------------------------------------------------------ DRAG (пружинный захват + support guard)
    _beginDrag(evt) {
        if (!this.dragEnabled || !this.rootRef) return;
        const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY,
            m => m.name.startsWith('col_') && m.isEnabled());
        if (!pick || !pick.hit) return;
        const ref = this.colliderRefs.find(r => r.mesh === pick.pickedMesh);
        if (!ref) return;
        const invW = BABYLON.Matrix.Invert(ref.mesh.getWorldMatrix());
        this.dragState = {
            ref,
            grabLocal: BABYLON.Vector3.TransformCoordinates(pick.pickedPoint, invW),
            planePoint: pick.pickedPoint.clone(),
            planeNormal: this.camera.getForwardRay().direction.normalize(),
        };
    }

    _updateDragSpring(dt) {
        const st = this.dragState;
        if (!st) return;
        const P = this.params;
        const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, BABYLON.Matrix.Identity(), this.camera);
        const den = BABYLON.Vector3.Dot(ray.direction, st.planeNormal);
        const tt = BABYLON.Vector3.Dot(st.planePoint.subtract(ray.origin), st.planeNormal) / den;
        const targetPoint = ray.origin.add(ray.direction.scale(tt));

        const body = st.ref.agg.body;
        const mass = (() => { try { return body.getMass() || 1; } catch (_) { return 1; } })();
        const cur = BABYLON.Vector3.TransformCoordinates(st.grabLocal, st.ref.mesh.getWorldMatrix());
        const vel = (() => { try { return body.getLinearVelocity(); } catch (_) { return BABYLON.Vector3.Zero(); } })();
        const err = targetPoint.subtract(cur);
        const force = err.scale(P.dragStiff).subtract(vel.scale(P.dragDamp)).scaleInPlace(mass);
        const maxF = mass * 900;
        const fl = force.length();
        if (fl > maxF) force.scaleInPlace(maxF / fl);

        // SUPPORT GUARD: пока стопы на опоре — таз нельзя поднять выше supportY + restRootAboveSupport
        if (this.supportGuard && st.ref === this.rootRef) {
            const fs = this.feetSupport;
            if (fs.supported > 0 && fs.supportY !== null) {
                const maxY = fs.supportY + this.restRootAboveSupport * 0.99;
                const rootY = this.rootRef.mesh.getAbsolutePosition().y;
                if (rootY >= maxY && force.y > 0) {
                    force.y = 0;
                    this.guardClamped = true;
                    let rv = body.getLinearVelocity ? body.getLinearVelocity() : BABYLON.Vector3.Zero();
                    if (rv.y > 0) { try { body.setLinearVelocity(new BABYLON.Vector3(rv.x, 0, rv.z)); } catch (_) {} }
                }
            }
        }

        body.applyImpulse(force.scale(dt), cur);
        body.wakeUp();
    }

    endDrag() {
        this.dragState = null;
    }

    // ------------------------------------------------------------------ главный tick
    _tick() {
        const engine = this.scene.getEngine();
        const dt = clampF(engine.getDeltaTime() / 1000, 1 / 240, 1 / 15);
        const t = performance.now() / 1000;
        this.guardClamped = false;

        // 1) Опора читается непрерывно (коллизии + рейкасты)
        this.feetSupport = this.getFeetSupport();

        // 2) Мастер: locomotion + анимация
        this.master.update(dt, t);

        // 3) Slave: веса → приводы → баланс → IK
        if (this.activeEnabled) {
            this._updateReactions(dt);
            this._updateStability(dt);
            this._updateSlaveController(dt);
            this._followAnimation(dt);
            this._applyBalance(dt);
            this.footIK.update(dt);
        }

        // 4) Drag
        this._updateDragSpring(dt);

        // 5) Скининг: мировые позы физ.тел → кости
        this._syncSkinning();

        // 6) Камера следует за тазом
        if (this.rootRef && this.options.cameraFollow !== false) {
            const tp = this.rootRef.mesh.getAbsolutePosition().add(new BABYLON.Vector3(0, 0.35, 0));
            this.camera.target = BABYLON.Vector3.Lerp(this.camera.target, tp, Math.min(1, dt * 4));
        }

        // 7) prevVel в конце кадра — для регистрации Δv коллизий следующим кадром
        for (const ref of this.colliderRefs) {
            try { ref.prevVel.copyFrom(ref.agg.body.getLinearVelocity()); } catch (_) {}
        }
    }

    // ------------------------------------------------------------------ публичный API
    setIntent(dirVector3, running = false) {
        this.externalIntent = dirVector3 && dirVector3.lengthSquared() > 1e-6
            ? { dir: new BABYLON.Vector3(dirVector3.x, 0, dirVector3.z), running }
            : null;
    }
    clearIntent() { this.externalIntent = null; }
    setSpeedLimit(v) { this.externalSpeedLimit = v; }

    setParam(key, value) {
        this.params[key] = value;
        if (key === 'gravity' && this.physicsEngine?.setGravity) {
            try { this.physicsEngine.setGravity(new BABYLON.Vector3(0, -value, 0)); } catch (_) {}
        }
        if (key === 'linDamp' || key === 'angDamp') {
            for (const ref of this.colliderRefs) {
                try { ref.agg.body.setLinearDamping(this.params.linDamp); ref.agg.body.setAngularDamping(this.params.angDamp); } catch (_) {}
            }
        }
    }

    setFeature(name, on) {
        if (name === 'balance') this.balanceEnabled = !!on;
        else if (name === 'reactions') this.reactionsEnabled = !!on;
        else if (name === 'supportGuard') this.supportGuard = !!on;
        else if (name === 'active') { this.activeEnabled = !!on; this.wakeAll(); }
        else if (name === 'drag') { this.dragEnabled = !!on; if (!on) this.endDrag(); }
        else if (name === 'masterVisible') { if (this.master.mesh) this.master.mesh.setEnabled(!!on); }
    }

    wakeAll() { for (const r of this.colliderRefs) { try { r.agg.body.wakeUp(); } catch (_) {} } }

    // Принудительный ragdoll (например, смерть/нокаут из HealthSystem)
    knockdown(reason = 'manual') {
        this.ragdollActive = true;
        this.ragdollCharge = this.params.ragdollDropDelay;
        if (this.hooks.onRagdoll) this.hooks.onRagdoll({ cause: reason, stability: this.globalStability });
    }
    recover() {
        this.ragdollActive = false;
        this.ragdollCharge = 0;
        this.getUpProgress = 1;
        for (const ref of this.colliderRefs) { ref.stress = 0; ref.limp = 0; ref.driveStress = 0; }
    }

    die() {
        this.slaveAlive = false;
        this.slaveDeadStep = 0;
        this.resetForces();
    }
    comeAlive() {
        this.slaveAlive = true;
        this.slaveStrength = 0;
        this.wakeAll();
    }
    resetForces() {
        this.slaveStrength = 0;
        this.forceCoefficient = 0;
        this.torqueCoefficient = 0;
    }

    applyImpulseToBone(boneNamePart, speed, dir) {
        const ref = this.colliderRefs.find(r => r.name.toLowerCase().includes(String(boneNamePart).toLowerCase()));
        if (!ref) return false;
        const d = dir || new BABYLON.Vector3(Math.random() - 0.5, Math.random() * 0.7 + 0.25, Math.random() - 0.5).normalize();
        let mass = 1; try { mass = ref.agg.body.getMass() || 1; } catch (_) {}
        try { ref.agg.body.applyImpulse(d.normalize().scale(speed * mass), ref.mesh.getAbsolutePosition()); ref.agg.body.wakeUp(); } catch (_) { return false; }
        return true;
    }

    // Тестовый снаряд (мяч) — идея из прототипа для проверки реакций
    throwBallAtCharacter(speed = 8) {
        if (!this.rootRef) return null;
        const scene = this.scene;
        let ballMesh = scene.getMeshByName('cc_ball'), ballAgg = null;
        if (!ballMesh) {
            ballMesh = BABYLON.MeshBuilder.CreateSphere('cc_ball', { diameter: 0.35 }, scene);
            const bm = new BABYLON.StandardMaterial('cc_ballMat', scene);
            bm.diffuseColor = new BABYLON.Color3(1, 0.4, 0.2);
            ballMesh.material = bm;
            const agg = new BABYLON.PhysicsAggregate(ballMesh, BABYLON.PhysicsShapeType.SPHERE, {
                mass: 4, restitution: 0.15, friction: 0.8,
                collisionGroup: COL_GROUP.GROUND, collisionMask: ~0,
            }, scene);
            ballMesh._ccAgg = agg;
            ballMesh.isPickable = false;
        }
        ballAgg = ballMesh._ccAgg;
        const target = this.rootRef.mesh.getAbsolutePosition().clone();
        const camPos = this.camera.position.clone();
        const dirToChar = target.subtract(camPos); dirToChar.y = 0;
        if (dirToChar.lengthSquared() < 1e-6) dirToChar.set(0, 0, 1);
        dirToChar.normalize();
        const spawn = camPos.add(dirToChar.scale(1.0)); spawn.y = target.y;
        try { ballAgg.body.setTransformation(spawn, BABYLON.Quaternion.Identity()); } catch (_) {}
        try {
            ballAgg.body.setLinearVelocity(dirToChar.scale(Math.max(4, speed)));
            ballAgg.body.setAngularVelocity(BABYLON.Vector3.Zero());
            ballAgg.body.wakeUp();
        } catch (_) {}
        return ballMesh;
    }

    getState() {
        return {
            charState: this.master.state,
            slaveState: this.slaveStateTxt,
            ragdoll: this.ragdollActive,
            stability: this.globalStability,
            followingScale: this.followingScale,
            stagger: this.staggerCoef,
            strength: this.slaveStrength,
            feetSupported: this.feetSupport.supported + '/' + this.feetSupport.total,
            supportY: this.feetSupport.supportY,
            followErrPos: this.followErrPos,
            followErrRot: this.followErrRot,
            guardClamped: this.guardClamped,
        };
    }

    dispose() {
        for (const o of this._observers) { try { this.scene.onBeforeRenderObservable.remove(o); } catch (_) {} try { this.physicsEngine.onCollisionObservable.remove(o); } catch (_) {} }
        this._observers = [];
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        if (this._onPointerDown) this.scene.getEngine().getRenderingCanvas().removeEventListener('pointerdown', this._onPointerDown);
        if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
        this.footIK.dispose();
        this.master.destroy();
        for (const c of this.constraints) { try { c.dispose(); } catch (_) {} }
        this.constraints = [];
        for (const ref of this.colliderRefs) {
            if (ref.savedLinkedNode) { try { ref.bone.linkTransformNode(ref.savedLinkedNode); } catch (_) {} }
            try { ref.agg.dispose(); } catch (_) {}
            try { ref.mesh.dispose(); } catch (_) {}
        }
        this.colliderRefs = [];
        this.slaveBodyMap.clear();
        this.boneToRef.clear();
        this.scene.meshes.forEach(m => { if (m.name.startsWith('col_')) m.dispose(); });
    }
}
