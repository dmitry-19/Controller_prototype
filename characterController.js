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
//                     ├──► MasterFootSystem (two-bone IK v71 + predictive landing 1c9eff + spring-contact)
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
//
//  ИНТЕГРАЦИЯ DeepSeek-прототипов (мастер-слой):
//   • deepseek_html_20261028_1c9eff.html — предиктивная посадка стопы (predictLandingXZ:
//     экстраполяция XZ по скорости корня, 8-лучевой поиск вверх-уступа, commit/lock с
//     гистерезисом, плавные константы времени dampFactor), калибровочный профиль локации
//     (restAnkleOffset/minAnkleY/swingAmp/ballRestOffset/restGroundY → blend опоры),
//     компенсация таза по посаженным стопам (pelvisDeltaY), пульс скорости шага GAIT_SPEED_K.
//   • deepseek_html_20261028_644a29.html — градиентное поле анимаций (IDW-веса ключевых точек
//     по осям fwd/side), ramp Walk→Run→Sprint, инерционный spring-constraint контакт стопы
//     (decaySpringVec3 / contactUpdate), zone/slope множители скорости, onBeforeRender-перехват
//     клипов мастера (заморозка скелета при ragdoll и масштабирование весов на followingScale).
//   Профили калибровки подхватываются из «ik_calibration_<model>.json» (экспорт первого файла).
// =================================================================================================

// --------------------------------------------------------------------------- утилиты
const clampF = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpF = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clampF((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// frame-rate independent damping (идея обоих DeepSeek-прототипов): коэффициент за кадр
const dampF = (dt, tau) => 1 - Math.exp(-dt / Math.max(0.001, tau));

// --------------------------------------------------------------------------- скалярный math-слой
// (перенос 1-в-1 из deepseek_html_20261028_644a29.html: LN2 / fastNegExp / decaySpring —
//  инерционный spring-контакт стопы; и из deepseek_html_20261028_1c9eff.html: smoothstep01)
const LN2 = 0.69314718056;
const fastNegExp = (x) => 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
// критически демпфированная пружина с «полураспадом» hl (decaySpringToRef, без аллокаций)
function decaySpringToRef(x, v, hl, dt, outX, outV) {
    const y = (4 * LN2 / (hl + 1e-5)) / 2;
    const j1x = v.x + x.x * y, j1y = v.y + x.y * y, j1z = v.z + x.z * y;
    const e = fastNegExp(y * dt);
    const nydt = y * dt;
    outX.set(x.x + j1x * dt, x.y + j1y * dt, x.z + j1z * dt);
    outX.scaleInPlace(e);
    outV.set(v.x - j1x * nydt, v.y - j1y * nydt, v.z - j1z * nydt);
    outV.scaleInPlace(e);
}
const smoothstep01 = (t) => { t = clampF(t, 0, 1); return t * t * (3 - 2 * t); };

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

    // ===== Master layer: ideas from deepseek_html_20261028_1c9eff.html =====
    masterBlendTau: 0.05,           // τ сглаживания blend опоры стопы (rawBlend → blendSmooth)
    predictive: true,               // предиктивная посадка стопы (predictLandingXZ)
    predRadius: 0.22,               // радиус 8-лучевого поиска опоры вокруг точки прицела
    predMaxOffset: 0.30,            // максимальный сдвиг точки прицела от «анимационной» стопы
    predInfluence: 0.85,            // вес landing-цели в фазе переноса
    predInfluenceAtPlant: 1.0,      // вес цели после commit (стопу держим на месте)
    predLockBlend: 0.85,            // blend ниже которого нельзя lock (фаза переноса)
    predLockExit: 0.55,             // гистерезис выхода из lock
    predCommitBlend: 0.70,          // blend, при котором landing «замораживается» по XZ (soft commit)
    predHysteresis: 0.06,           // прилипание к текущей точке посадки (м/с), защита от дрожания
    predRaiseThreshold: 0.04,       // насколько выше должен быть луч, чтобы сместить точку
    predSmoothTauXZ: 0.10,          // τ сглаживания XZ
    predSmoothTauY: 0.18,           // τ сглаживания Y (медленнее — вертикаль стабильнее)
    gaitSpeedK: 0.20,               // пульс скорости мастера по фазе шага (GAIT_SPEED_K)

    // ===== Master layer: ideas from deepseek_html_20261028_644a29.html =====
    fieldSharpness: 2.5,            // острота IDW-поля градиента (sharpness)
    fieldEps: 0.0001,               // защита от деления на ноль в IDW
    rampUpTime: 8.0,                // ramp walk→run→sprint (s)
    rampDownTime: 6.0,              // затухание ramp без ввода (s)
    inputSmoothTau: 0.10,           // τ сглаживания вектора ввода
    sprintRampTime: 0.6,            // время входа в спринт- tier (v71 sprintT)
    rampMaxNoShift: 0.35,           // потолок ramp без Shift (walk tier)
    shiftPierce: 0.5,               // доля speedLimit, «пробиваемая» Shift'ом
    slopeFactor: 1.35,              // усиление уклона: boost и множитель скорости
    sprintBlockZone: 0.55,          // zoneMul ниже этого — спринт заблокирован
    sprintBlockSlope: 0.30,         // крутой подъём выше этого — спринт заблокирован
    turnIdleBlend: 0.35,            // подмешивание idle при повороте (v71 rotBlend)
    fadeIn: [0.18, 0.62],           // скорость набора веса клипа [быстро..медленно]
    fadeOut: [0.22, 0.72],          // скорость сброса веса клипа
    valueUp: [0.12, 0.42],          // τ разгона valueFwd/Side
    valueDown: [0.10, 0.32],        // τ торможения valueFwd/Side
    modeSpeedMul: { loco: 1, strafe: 1, crouch: 0.55, injured: 0.45 },
    backIdleBlend: { crouch: 0.5, injured: 0.6 }, // idle при ходе назад в режиме
    autoInjured: false,             // авто-переключение в injured chain при низкой скорости
    injuredEnterZone: 0.45, injuredExitZone: 0.70,
    // Цепи локамоции v71 (5 цепей): массивы ключей [{animName|group, center, plateau}]
    // fwd/side оси в единицах valueFwd/valueSide (0..1 поле градиента).
    chains: {
        locoFwd:    null,   // Idle(0) → Walk → Run → Sprint (автодетект из клипов, если null)
        locoBack:   null,   // backward-цепь loco (center < 0)
        strafeLeft: null,   // side-цепь влево
        strafeRight:null,   // side-цепь вправо
        crouchFwd:  null,   // crouch-локомоция (режим crouch)
        injuredFwd: null,   // injured/hurt-локомоция (режим injured)
    },
    contactSpringHalfLife: 0.05,    // hl инерционного spring-контакта стопы
    contactUnlockRadius: 0.15,      // ur — рассогласование, разрывающее lock контакта
    masterClipWeightScale: true,    // масштабировать веса клипов мастера на followingScale
    freezeMasterOnRagdoll: true,    // ragdoll → скелет мастера замораживается в rest-позе

    // Компенсация таза по посаженным стопам (pelvisDeltaY):
    pelvisCompensation: true,
    pelvisTau: 0.14,                // τ сглаживания ΔY таза
    pelvisPlantedBlend: 0.70,       // blend, начиная с которого стопа считается «посаженной»
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
        // yaw-угол world-forward в rest-позе: мастер поворачивается на this.yaw от этой базы
        const forwardAngleYaw = Math.atan2(forward.x, forward.z);
        return { up, right, forward, center, forwardAngleYaw };
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
        // --- master-layer v71 (deepseek_html_20261028_644a29.html) ---
        this.batchCalibrating = false;   // на время batch-калибровки locomotion заморожен
        this._curClipName = '';          // имя текущего проигрываемого клипа
        this._field = { fwd: 0, side: 0 }; // IDW-поле анимаций (blend field)
        this._fwdS = 0; this._sideS = 0;   // сглаженные оси движения
        this._ramp = 0;                    // 0..1 плавная смена скорости локомоции
        // --- v71 locomotion state (inputZ→fwd, inputX→side, rampT/sprintT/tiers) ---
        this.inputFwd = 0; this.inputSide = 0;   // сглаженные компоненты ввода [-1..1]
        this.valueFwd = 0; this.valueSide = 0;   // координаты точки в blend-поле цепей
        this.rampT = 0; this.sprintT = 0;        // ramp walk→run→sprint и спринт-подъём
        this.speed = 0; this.speedTarget = 0;    // м/с мастера (факт/цель)
        this.slopeGrad = 0;                      // тангенс уклона под мастером (+ подъём)
        this.zoneMul = 1;                        // внешняя зона скорости (AI/health/stamina)
        this.clipMode = 'procedural';            // 'groups' | 'chains' | 'procedural'
        this.modeBindings = {}; this.chains = { locoFwd: [], locoBack: [], strafeLeft: [], strafeRight: [], crouchFwd: [], injuredFwd: [] };
        this.prevMode = 'loco'; this.autoInjuredActive = false;
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
        // 'chains' — полноценный блендер 5 цепей v71; включается, если есть locoFwd-цепь с ≥2 ключами
        this.clipMode = this.mode;          // 'groups' | 'procedural' | 'chains'

        // name → group (для калибровки профилей MasterFootSystem и blend-поля)
        cc.animByName = new Map();
        for (const g of (animGroups || [])) cc.animByName.set(g.name, g);
        // world-forward мастера (идея оригинала: forward mesh'а мастера для предикции стопы)
        this.forwardVec = new BABYLON.Vector3(0, 0, 1);

        // --- v71: 5 цепей локамоции + режимы (autoDetectModes из deepseek_html_20261028_644a29.html) ---
        this._buildChains();
    }

    // ------------------------------------------------------------------
    // ЦЕПИ ЛОКОМОЦИИ (port v71: normalizeChain/chainTiers/autoDetectModes).
    // Пять цепей: locoFwd (Idle→Walk→Run→Sprint), locoBack, strafeLeft,
    // strafeRight, crouchFwd; плюс injuredFwd как опциональная 6-я.
    // Если пользователь задал params.chains — используется он; иначе ключи
    // автодетектируются из имён клипов (walk/run/sprint/back/strafe/crouch/injured).
    _mkKey(name, center) { return { animName: name, center }; }
    _findClip(re, excludeRe) {
        for (const [n] of this.cc.animByName) {
            const ln = n.toLowerCase();
            if (re.test(ln) && !(excludeRe && excludeRe.test(ln))) return n;
        }
        return null;
    }
    _buildChains() {
        const P = this.cc.params;
        const user = P.chains || {};
        const byN = (u, auto) => (Array.isArray(u) && u.length ? u.map(k => ({ animName: k.animName, center: k.center ?? 0 })) : auto);
        const idleN = this.groups.idle ? this.groups.idle.name : null;
        const walkN = this._findClip(/walk/, /back|strafe|crouch|injured|hurt|sprint|run|jog/);
        const runN  = this._findClip(/(^|[^a-z])(run|jog)([^a-z]|$)/i, /back|strafe|crouch|sprint/);
        const sprN  = this._findClip(/sprint/, /back|strafe/);
        const backN = this._findClip(/back/i, /strafe|pack|stack|black/);
        const strL  = this._findClip(/strafe.*l|^side_l|left/i, /run|sprint/);
        const strR  = this._findClip(/strafe.*r|^side_r|right/i, /run|sprint/);
        const crN   = this._findClip(/crouch/, /back|run|sprint/);
        const injN  = this._findClip(/injured|hurt/, /back/);

        this.chains = {
            locoFwd: byN(user.locoFwd, [idleN, walkN, runN, sprN].filter(Boolean)
                .map((n, i) => this._mkKey(n, [0, 0.3, 0.65, 0.9][i]))),
            locoBack: byN(user.locoBack, [backN, crN && injN ? null : null].filter(Boolean)
                .map((n, i) => this._mkKey(n, [-0.5 - i * 0.25]))),
            strafeLeft: byN(user.strafeLeft, [strL].filter(Boolean).map(n => this._mkKey(n, -0.6))),
            strafeRight: byN(user.strafeRight, [strR].filter(Boolean).map(n => this._mkKey(n, 0.6))),
            crouchFwd: byN(user.crouchFwd, [crN].filter(Boolean).map(n => this._mkKey(n, 0.35))),
            injuredFwd: byN(user.injuredFwd, [injN].filter(Boolean).map(n => this._mkKey(n, 0.3))),
        };
        // modeBindings (v71): loco={fwd}, strafe={fwd+side L/R}, crouch={crouchFwd}, injured={injuredFwd}
        this.modeBindings = {};
        if (this.chains.locoFwd.length) this.modeBindings.loco = { fwdId: 'locoFwd', backId: 'locoBack' };
        if (this.chains.locoFwd.length && (this.chains.strafeLeft.length || this.chains.strafeRight.length))
            this.modeBindings.strafe = { fwdId: 'locoFwd', backId: 'locoBack', sideIds: ['strafeLeft', 'strafeRight'] };
        if (this.chains.crouchFwd.length) this.modeBindings.crouch = { fwdId: 'crouchFwd' };
        if (this.chains.injuredFwd.length) this.modeBindings.injured = { fwdId: 'injuredFwd' };
        this.mode = this.modeBindings.loco ? 'loco' : 'none';
        this.prevMode = 'loco';
        this.autoInjuredActive = false;
        // веса клипов мастера: currentW (port currentW/setGroupWeight)
        this._curW = new Map();
        for (const n of this.cc.animByName.keys()) this._curW.set(n, 0);
        if (this.clipMode === 'groups' && this.chains.locoFwd.length >= 2) {
            this.clipMode = 'chains';       // есть полная loco-цепь → включаем блендер v71
            this._snapNext = true;
        }
    }
    getChain(id) { return this.chains[id] || null; }
    // chainTiers (v71): позиции walk/run/sprint внутри fwd-цепи
    chainTiers(cF) {
        const def = { walk: 0.3, run: 0.65, sprint: 0.9 };
        if (!cF || !cF.length) return def;
        const pos = cF.filter(k => k.center > 0.05).slice().sort((a, b) => a.center - b.center);
        if (!pos.length) return def;
        let walk = pos[0].center, run = pos[pos.length - 1].center, sprint = run;
        for (const k of pos) {
            const nm = k.animName.toLowerCase();
            if (/walk/.test(nm) && !/back/.test(nm)) walk = k.center;
            if (/(jog|run)/.test(nm) && !/sprint|back/.test(nm)) run = k.center;
            if (/sprint/.test(nm)) sprint = k.center;
        }
        return { walk, run, sprint };
    }
    chainRange(cF) {
        if (!cF || !cF.length) return { min: 0, max: 0 };
        let min = Infinity, max = -Infinity;
        for (const k of cF) { min = Math.min(min, k.center); max = Math.max(max, k.center); }
        return { min, max };
    }
    // buildField (v71): опорные точки IDW-поля из активных цепей режима
    buildField(mode) {
        const b = this.modeBindings[mode || this.mode];
        const pts = []; const seen = new Set();
        if (!b) return pts;
        const addChain = (id, axis) => {
            const c = this.getChain(id);
            if (!c) return;
            for (const k of c) {
                if (axis === 'side' && Math.abs(k.center) < 0.05) continue;
                if (seen.has(k.animName)) continue; seen.add(k.animName);
                pts.push(axis === 'fwd' ? { animName: k.animName, x: 0, y: k.center }
                                        : { animName: k.animName, x: k.center, y: 0 });
            }
        };
        addChain(b.fwdId, 'fwd');
        if (b.backId) addChain(b.backId, 'fwd');
        if (b.sideIds) for (const sid of b.sideIds) addChain(sid, 'side');
        return pts;
    }
    // computeContribs (v71): IDW w_i = 1/d_i^sharpness / Σ
    computeContribs(pts, vx, vy, sharp) {
        if (!pts.length) return [];
        const eps = this.cc.params.fieldEps ?? 0.0001;
        let sum = 0; const ws = [];
        for (const p of pts) {
            const dx = p.x - vx, dy = p.y - vy;
            const d2 = dx * dx + dy * dy + eps;
            const w = 1 / Math.pow(d2, sharp / 2);
            ws.push(w); sum += w;
        }
        return pts.map((p, i) => ({ animName: p.animName, weight: ws[i] / sum }));
    }
    setMode(m) {
        if (m === this.mode) return;
        if (!this.modeBindings[m]) return;
        this.prevMode = this.mode; this.mode = m;
        if (m !== 'injured') this.autoInjuredActive = false;
    }
    // getIdleForCurrentMode (v71): idle-клип привязан к нулевому ключу fwd-цепи
    idleAnimName() {
        const b = this.modeBindings[this.mode];
        const cF = b ? this.getChain(b.fwdId) : null;
        if (cF) for (const k of cF) if (Math.abs(k.center) < 0.05) return k.animName;
        return this.groups.idle ? this.groups.idle.name : null;
    }
    static _tv(P, key, t) { const v = P[key]; return Array.isArray(v) ? lerpF(v[0], v[1], clampF(t, 0, 1)) : v; }

    // setGroupWeight (v71): вес через animatables клипа
    setClipWeight(g, w) {
        if (!g) return;
        if (!isFinite(w)) w = 0; w = clampF(w, 0, 1);
        try { for (const x of g.animatables ?? []) { if (x) { try { x.weight = w; } catch (_) {} } } } catch (_) {}
    }

    // ------------------------------------------------------------------
    // applyWeights (port v71): цели весов из IDW-поля цепей + idle-бленды,
    // плавные fade in/out по текущим весам. Заменяет грубый переключатель
    // «один клип» в animate() — режим 'groups' теперь полноценный блендер.
    applyWeights(dt) {
        const cc = this.cc, P = cc.params;
        if (!this._curW) return;
        const targets = new Map();
        const fieldMode = this.clipBlendActive();
        if (fieldMode) {
            const pts = this.buildField();
            const sharp = MasterController._tv(P, 'fieldSharpness', 0.5);
            const contribs = this.computeContribs(pts, this._fwdS, this._sideS, sharp);
            for (const c of contribs) if (c.weight > 0.001) targets.set(c.animName, c.weight);
        } else {
            // вне blend-режима (ragdoll/fall/калибровка): целевой клип один
            const want = this._stateClipName();
            if (want) targets.set(want, 1);
        }
        // idle-бленды v71: rotBlend (поворот) + extraIdleBlend (ход назад в crouch/injured)
        let extraIdle = 0;
        if (fieldMode && this.valueFwd < -0.02) {
            const bi = P.backIdleBlend || {};
            if (this.mode === 'crouch') extraIdle = (bi.crouch ?? 0.5) * Math.min(1, Math.abs(this.valueFwd));
            else if (this.mode === 'injured') extraIdle = (bi.injured ?? 0.6) * Math.min(1, Math.abs(this.valueFwd));
        }
        const inputX = Math.abs(this.inputSide || 0);
        let rotBlend = inputX > 0.08 ? Math.min(P.turnIdleBlend, inputX * P.turnIdleBlend) : 0;
        const totalIdleBlend = clampF(rotBlend + extraIdle, 0, 0.85);
        const idleG = this.idleAnimName();
        if (totalIdleBlend > 0.001 && idleG) {
            let sum = 0; for (const [, w] of targets) sum += w;
            if (sum > 0.001) {
                for (const [name, w] of targets) if (w > 0) targets.set(name, w * (1 - totalIdleBlend));
                targets.set(idleG, (targets.get(idleG) || 0) + totalIdleBlend);
            }
        }
        // truly idle → только idle-клип
        if (Math.abs(this.valueFwd) < 0.02 && Math.abs(this.valueSide) < 0.02 && (this.speed || 0) < 0.05 && idleG) {
            targets.clear(); targets.set(idleG, 1);
        }
        // ramp-скорость проигрывания циклов (walk tier → sprint tier), как speedRatio в v71
        const spdMul = 0.7 + 0.6 * clampF(this._ramp, 0, 1);

        const fastT = clampF(Math.hypot(this.valueFwd, this.valueSide), 0, 1);
        for (const [name, g] of cc.animByName) {
            const tgt = targets.get(name) || 0;
            const cur = this._curW.get(name) || 0;
            const diff = tgt - cur;
            let next;
            if (this._snapNext) { next = tgt; }
            else {
                const step = dt / Math.max(0.01, diff > 0 ? MasterController._tv(P, 'fadeIn', fastT)
                                                          : MasterController._tv(P, 'fadeOut', fastT));
                next = Math.abs(diff) < step ? tgt : cur + Math.sign(diff) * step;
            }
            this._curW.set(name, next);
            if (next > 0.005) {
                if (!g.isStarted || !g.isPlaying) { try { g.play(true); } catch (_) {} }
                try { g.speedRatio = spdMul; } catch (_) {}
                this.setClipWeight(g, next);
            } else if (cur > 0.005 && next <= 0.005) {
                this.setClipWeight(g, 0);
                try { g.stop(); } catch (_) {}
            }
        }
        this._snapNext = false;
    }
    clipBlendActive() {
        const cc = this.cc;
        return this.clipMode === 'chains' && this.modeBindings[this.mode] &&
               !cc.ragdollActive && this.state !== 'FALLING' && !this.batchCalibrating;
    }
    _stateClipName() {
        if (this.state === 'FALLING') return (this.groups.fall || this.groups.idle)?.name || null;
        if (this.state === 'RUNNING') return (this.groups.run || this.groups.walk || this.groups.idle)?.name || null;
        if (this.state === 'WALKING') return (this.groups.walk || this.groups.idle)?.name || null;
        return this.groups.idle?.name || null;
    }

    _depth(b) { let d = 0, pp = b.getParent(); while (pp) { d++; pp = pp.getParent(); } return d; }

    // Проигрывание клипа по группе (используется MasterFootSystem при калибровке)
    playGroup(groupOrName, loop = true) {
        const cc = this.cc;
        let g = groupOrName;
        if (typeof g === 'string') g = cc.animByName.get(g);
        if (!g) return;
        if (this.curGroup && this.curGroup !== g) { try { this.curGroup.stop(); } catch (_) {} }
        try { g.play(loop); } catch (_) {}
        this.curGroup = g;
        this._curClipName = g.name;
        cc.masterFeet.activeAnimName = g.name;
        cc.masterFeet.resetOnAnimSwitch();
    }
    stopAllGroups() {
        for (const g of this.cc.animByName.values()) { try { g.stop(); } catch (_) {} }
        this.curGroup = null; this._curClipName = '';
    }
    // Оси локального blend-поля (задаются из CharacterController: LM.forward/right)
    setFieldAxes(fx, fz, rx, rz) { this._field.fwdAxis = [fx, fz]; this._field.sideAxis = [rx, rz]; }

    // ------------------------------------------------------------------
    // Legacy-вспомогательная функция: IDW-сглаживание вектора world-скорости мастера
    // в локальные оси blend-поля (fwd/side). Используется только для диагностики и
    // обратной совместимости; основной путь поля — valueFwd/valueSide → _fwdS/_sideS.
    projectVelocityToField(vx, vz) {
        const f = this._field;
        if (!f.fwdAxis) { f.fwdAxis = [0, 1]; f.sideAxis = [1, 0]; }
        return { fwd: vx * f.fwdAxis[0] + vz * f.fwdAxis[1], side: vx * f.sideAxis[0] + vz * f.sideAxis[1] };
    }
    updateBlendField(dt, vx, vz) {
        const P = this.cc.params;
        const f = this._field;
        const pr = this.projectVelocityToField(vx, vz);
        const tau = Math.max(1e-3, P.inputSmoothTau ?? 0.1);
        const k = dampF(dt, tau);
        f.fwd += (pr.fwd - f.fwd) * k;
        f.side += (pr.side - f.side) * k;
        const maxR = Math.max(0.5, P.runSpeed * 1.4);
        let len = Math.hypot(f.fwd, f.side);
        if (len > maxR && len > 1e-6) { f.fwd *= maxR / len; f.side *= maxR / len; }
        f.targetFwd = f.fwd;
        f.targetSide = f.side;
    }

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
        // v71: A/D в не-strafe режимах — поворот корпуса, а не боковое движение
        const strafeMode = this.clipMode === 'chains' && this.mode === 'strafe';
        // В не-strafe режимах чистый поворот (только A/D) — без движения вперёд (v71 wasOnlyTurn)
        if (!strafeMode && Math.abs(fwd) < 0.01 && Math.abs(side) > 0.01) {
            return { moveDir: new BABYLON.Vector3(0, 0, 1), turnOnly: -side, running: keys.has('ShiftLeft') || keys.has('ShiftRight'), moving: true };
        }
        const cam = cc.camera;
        const camDir = cam.getForwardRay().direction.clone();
        camDir.y = 0;
        if (camDir.lengthSquared() < 1e-6) camDir.set(0, 0, -1);
        camDir.normalize();
        // camera-right = cross(up, camDir): D → право камеры (совпадает с v71 dx=cos(camYaw)*inputX)
        const camRight = BABYLON.Vector3.Cross(new BABYLON.Vector3(0, 1, 0), camDir).normalize();
        const moveDir = camDir.scale(fwd).add(camRight.scale(strafeMode ? side : 0));
        if (moveDir.lengthSquared() < 1e-8) moveDir.set(0, 0, 1);
        return { moveDir: moveDir.normalize(), turnOnly: strafeMode ? 0 : -side, running: keys.has('ShiftLeft') || keys.has('ShiftRight'), moving: true };
    }

    update(dt, t) {
        const cc = this.cc, P = cc.params;
        if (!this.mesh || !cc.rootRef) return;
        const pos = this.mesh.position;

        // Опора под мастером (+ уклон v71: два луча «под» и «впереди по forward»)
        const ray = new BABYLON.Ray(pos.add(new BABYLON.Vector3(0, 0.35, 0)), new BABYLON.Vector3(0, -1, 0), 6);
        const hit = cc.scene.pickWithRay(ray, cc.supportPredicate);
        let groundY = 0;
        if (hit && hit.hit && hit.pickedPoint) groundY = hit.pickedPoint.y;
        this.grounded = (pos.y - groundY) < P.groundDistance + 0.15;
        // slopeGrad (port updateSlope): подъём >0 → тормозит, спуск <0 → разгоняет
        {
            const fvX = Math.sin(this.yaw), fvZ = Math.cos(this.yaw);
            const ay = cc.raycastSupportY(pos.x + fvX * 0.8, pos.z + fvZ * 0.8, pos.y + 1.5);
            const by = cc.raycastSupportY(pos.x - fvX * 0.8, pos.z - fvZ * 0.8, pos.y + 1.5);
            if (ay !== null && by !== null) {
                const gRaw = (ay - by) / 1.6;
                const k = 1 - fastNegExp(dt / 0.25);
                this.slopeGrad += (gRaw - this.slopeGrad) * k;
            } else this.slopeGrad *= (1 - Math.min(1, dt * 4));
        }
        // zoneMul: внешние зоны скорости (из health/stamina/AI — аналог updateZone в v71)
        this.zoneMul = clampF(cc.externalSpeedLimit ?? 1.0, 0, 2);

        let intent = this.getIntent();
        // Чистый поворот (только A/D в не-strafe): движение корпуса отсутствует —
        // иначе legacy-ветка ниже даст rawF=±1 и персонаж «поедет» при вращении на месте.
        if (intent.turnOnly && Math.abs(intent.turnOnly) > 0.01 && this.clipMode !== 'chains') {
            intent = { ...intent, moving: false };
        }
        // Batch-калибровка профилей: мастер играет клип на месте, locomotion заморожен
        if (this.batchCalibrating) intent = { moveDir: BABYLON.Vector3.Zero(), running: false, moving: false };

        // --- v71 input smoothing: rawWASD/AI → inputFwd/inputSide (τ=inputSmoothTau) ---
        {
            let rawF = 0, rawS = 0;
            if (intent.moving) {
                if (this.clipMode === 'chains') {
                    // v71-модель: W/S — fwd-компонента ввода, A/D — side (strafe) или поворот
                    const cam = cc.camera;
                    const camDir = cam.getForwardRay().direction.clone(); camDir.y = 0;
                    if (camDir.lengthSquared() < 1e-6) camDir.set(0, 0, -1); camDir.normalize();
                    const camRight = BABYLON.Vector3.Cross(new BABYLON.Vector3(0, 1, 0), camDir).normalize();
                    rawF = BABYLON.Vector3.Dot(intent.moveDir, camDir);
                    rawS = intent.turnOnly ? 0 : BABYLON.Vector3.Dot(intent.moveDir, camRight);
                    const m = Math.hypot(rawF, rawS);
                    if (m > 1) { rawF /= m; rawS /= m; }
                } else {
                    // legacy-режим: направление intent сразу задаёт и движение, и yaw
                    rawF = 1 * (BABYLON.Vector3.Dot(intent.moveDir, this.forwardVec) >= 0 ? 1 : -1);
                    rawF = intent.running ? rawF : rawF * 0.5;
                    rawS = 0;
                }
            }
            const kIn = 1 - fastNegExp(dt / Math.max(1e-3, P.inputSmoothTau ?? 0.1));
            this.inputFwd += (rawF - this.inputFwd) * kIn;
            this.inputSide += (rawS - this.inputSide) * kIn;
            if (Math.abs(this.inputFwd) < 0.01) this.inputFwd = 0;
            if (Math.abs(this.inputSide) < 0.01) this.inputSide = 0;
        }

        // --- v71 rampT/sprintT с блокировками спринта ---
        const inMove = Math.abs(this.inputFwd) > 0.1;
        const slowZone = this.zoneMul < P.sprintBlockZone;
        const steepUphill = this.slopeGrad > P.sprintBlockSlope;
        this.sprintBlocked = slowZone || steepUphill;
        const sprintAllowed = intent.running && !this.sprintBlocked;
        const baseMax = sprintAllowed ? 1.0 : P.rampMaxNoShift;
        const sfac = P.slopeFactor ?? 1.35;
        const slopeBoost = -this.slopeGrad * sfac;                       // знак сам рулит: спуск(+grad<0)→boost>0
        const zoneBoost = this.zoneMul > 1 ? (this.zoneMul - 1) * 0.35 : (this.zoneMul - 1) * 0.5;
        const targetRampMax = clampF(baseMax + slopeBoost + zoneBoost, 0, 1);
        const dampUp = 1 - fastNegExp(dt / Math.max(0.1, P.rampUpTime));
        const dampDn = 1 - fastNegExp(dt / Math.max(0.1, P.rampDownTime));
        if (inMove) this.rampT += (targetRampMax - this.rampT) * dampUp;
        else this.rampT += (0 - this.rampT) * dampDn;
        this.rampT = clampF(this.rampT, 0, 1);
        if (sprintAllowed) this.sprintT = clampF(this.sprintT + dt / Math.max(0.1, P.sprintRampTime), 0, 1);
        else {
            const dr = intent.running ? dt / Math.max(0.1, P.sprintRampTime * 1.5)
                                      : dt / Math.max(0.1, P.rampDownTime * 0.5);
            this.sprintT = clampF(this.sprintT - dr, 0, 1);
        }

        // --- auto-injured (v71): низкая скорость + замедленная зона → injured chain ---
        if (P.autoInjured && !cc.ragdollActive && this.modeBindings.injured && this.state !== 'FALLING') {
            const injSpeed = lerpF(P.walkSpeed * 0.2, P.walkSpeed * 0.45, 0.5);
            const speedLow = this.speed < injSpeed;
            const wantInjured = speedLow && this.zoneMul < (P.injuredEnterZone ?? 0.45);
            if (this.mode !== 'injured' && wantInjured) { this.setMode('injured'); this.autoInjuredActive = true; }
            else if (this.mode === 'injured' && this.autoInjuredActive && this.zoneMul >= (P.injuredExitZone ?? 0.7)) {
                this.setMode(this.prevMode || 'loco'); this.autoInjuredActive = false;
            }
        }

        // --- valueFwd/valueSide (port v71): tiers × ramp × totalMul → координаты поля ---
        {
            const b = this.modeBindings[this.mode];
            const cF = b ? this.getChain(b.fwdId) : null;
            const cB = b && b.backId ? this.getChain(b.backId) : null;
            const cS = b && b.sideIds ? this.getChain(b.sideIds[1]) : null;   // right-цепь задаёт sideRange
            const tiers = this.chainTiers(cF);
            const range = { min: cB && cB.length ? cB[cB.length - 1].center : 0, max: (cF && cF.length ? cF[cF.length - 1].center : 0) };
            const sideRange = cS && cS.length ? Math.max(...cS.map(k => Math.abs(k.center))) : 0.6;
            const slopeMul = clampF(1 - this.slopeGrad * sfac, 0.4, 2.0);
            let zoneEff = this.zoneMul;
            if (intent.running && zoneEff < 1) zoneEff = 1 + (zoneEff - 1) * (P.shiftPierce ?? 0.5);
            const modeMul = (P.modeSpeedMul || {})[this.mode] ?? 1;
            const rampE = smoothstep01(this.rampT), sprE = smoothstep01(this.sprintT);
            const effRamp = Math.max(rampE, sprE);
            const rampCenterAdj = tiers.walk + (tiers.run - tiers.walk) * effRamp;
            const curCenter = rampCenterAdj * (1 - sprE) + tiers.sprint * sprE;
            const totalMul = slopeMul * zoneEff * modeMul;
            let targetFwd = 0;
            if (inMove) {
                const rawF = Math.sign(this.inputFwd) * Math.abs(this.inputFwd) * curCenter * totalMul;
                targetFwd = clampF(rawF, range.min, range.max);
            }
            const targetSide = (this.mode === 'strafe') ? this.inputSide * sideRange : 0;
            const hasInput = Math.abs(targetFwd) > 0.02 || Math.abs(targetSide) > 0.02;
            const tauV = MasterController._tv(P, hasInput ? 'valueUp' : 'valueDown', clampF(Math.hypot(targetFwd, targetSide), 0, 1));
            const kV = 1 - fastNegExp(dt / Math.max(0.01, tauV));
            this.valueFwd += (targetFwd - this.valueFwd) * kV;
            this.valueSide += (targetSide - this.valueSide) * kV;
            if (!hasInput) {
                if (Math.abs(this.valueFwd) < 0.02) this.valueFwd = 0;
                if (Math.abs(this.valueSide) < 0.02) this.valueSide = 0;
            }
            this.valueFwd = clampF(this.valueFwd, range.min, range.max);
            // физическая скорость мастера: |valueFwd|/maxCenter × walk/run-скорость
            const maxC = Math.max(0.05, range.max);
            const spdBase = this.state === 'RUNNING' ? P.runSpeed : P.walkSpeed;
            this.speedTarget = clampF(Math.abs(this.valueFwd) / maxC, 0, 1.25) * spdBase * (sprE > 0.5 ? 1.15 : 1);
            if (this.valueFwd < -0.02) this.speedTarget = -this.speedTarget;
        }

        // состояние для slave/IK/FALLING
        this.state = !this.grounded ? 'FALLING' : (Math.abs(this.valueFwd) > 0.05 || Math.abs(this.valueSide) > 0.05
            ? (this.sprintT > 0.5 ? 'RUNNING' : 'WALKING') : 'IDLE');
        if (this.state !== 'FALLING') this.fallVel = 0;

        // --- поворот (port v71): strafe — доворачивание к камере, иначе A/D-поворот ---
        if (this.clipMode === 'chains') {
            const turnOnly = intent.turnOnly || 0;
            if (this.mode === 'strafe' && intent.moving) {
                const camDir = cc.camera.getForwardRay().direction.clone(); camDir.y = 0;
                if (camDir.lengthSquared() < 1e-6) camDir.set(0, 0, -1); camDir.normalize();
                const camYaw = Math.atan2(camDir.x, camDir.z);
                let d = camYaw - this.yaw;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                this.yaw += d * (1 - fastNegExp(dt / 0.2));
            } else if (intent.moving && Math.abs(turnOnly) > 0.03) {
                // v71: M.yaw -= inputX*turnSpeed*dt (A/D поворачивают корпус в loco/crouch/injured)
                const turnSpd = lerpF(Math.PI * 0.55, Math.PI * 1.45, clampF(this._ramp, 0, 1));
                this.yaw -= turnOnly * turnSpd * dt;
            } else if (intent.moving) {
                const targetYaw = Math.atan2(
                    BABYLON.Vector3.Cross(cc.LM.forward, intent.moveDir).y,
                    BABYLON.Vector3.Dot(cc.LM.forward, intent.moveDir)
                );
                this.yaw = smoothDampAngle(this.yaw, targetYaw, dt, P.turnSmoothTime);
            }
        } else if (intent.moving) {
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
            this.speedTarget = 0;
        } else if (Math.abs(this.speedTarget) < 0.01 && Math.abs(this.inputFwd) < 0.05) {
            pos.addInPlace(pushVec.scale(P.pushBackSpeed * pushScale * dt));
        } else {
            // v71: скорость мастера из ramp-значения valueFwd (вперёд/назад по yaw)
            const spd = this.speedTarget * masterMoveScale;
            const dirX = Math.sin(this.yaw), dirZ = Math.cos(this.yaw);
            const forward = new BABYLON.Vector3(dirX * spd, 0, dirZ * spd);
            // Support guard: мастер не шагает на поверхность выше maxStepHeight
            if (cc.supportGuard && forward.lengthSquared() > 1e-8) {
                const aheadY = cc.raycastSupportY(pos.x + dirX * 0.5, pos.z + dirZ * 0.5, pos.y + 1.5);
                if (aheadY !== null && aheadY - groundY > P.maxStepHeight) forward.set(0, 0, 0);
            }
            const back = pushVec.scale(P.pushBackSpeed * pushScale);
            pos.addInPlace(forward.add(back).scale(dt));
        }

        // speed → speedTarget с демпфом (port v71 sf2=dampFactor(dt,0.2))
        {
            const kS = 1 - fastNegExp(dt / 0.2);
            this.speed += (this.speedTarget - this.speed) * kS;
            if (Math.abs(this.speed - this.speedTarget) < 0.01) this.speed = this.speedTarget;
        }

        const floorY = groundY + P.groundDistance + this.bobY;
        if (pos.y < floorY) { pos.y = floorY; this.fallVel = 0; }
        else if (this.grounded) pos.y = lerpF(pos.y, floorY, Math.min(1, dt * 12));

        // --- blend-поле цепей (v71): сглаженные valueFwd/valueSide в осях мастера ---
        // (_fwdS/_sideS — координаты точки поля для computeContribs)
        {
            const bK = 1 - fastNegExp(dt / Math.max(1e-3, P.masterBlendTau ?? 0.05));
            this._fwdS += (this.valueFwd - this._fwdS) * bK;
            this._sideS += (this.valueSide - this._sideS) * bK;
            // _ramp (обратная совместимость HUD/state): нормализованная величина поля
            const refMax = Math.max(0.05, (this.chains.locoFwd.length ? this.chains.locoFwd[this.chains.locoFwd.length - 1].center : P.runSpeed));
            this._ramp += (clampF(Math.hypot(this._fwdS, this._sideS) / refMax, 0, 1) - this._ramp) * Math.min(1, dt / Math.max(1e-3, P.rampUpTime));
        }
        this.speedScale = clampF(this._ramp, 0, 1);
        // world-forward мастера (для предикции посадочной точки стоп)
        const fwdYaw = cc.LM.forwardAngleYaw || 0;
        this.forwardVec.set(Math.sin(this.yaw + fwdYaw), 0, Math.cos(this.yaw + fwdYaw));

        this.animate(dt, t);
        try { this.mesh.computeWorldMatrix(true); } catch (_) {}
        try { this.skeleton.computeAbsoluteMatrices(); } catch (_) {}
    }

    animate(dt, t) {
        const cc = this.cc;
        if (!this.mesh || !this.skeleton) return;
        if (this.clipMode === 'chains') {
            // --- v71: blend 5 цепей через веса клипов (port applyWeights + setGroupWeight) ---
            this.applyWeights(dt);
            // activeAnimName для foot-профилей/IK — самый «тяжёлый» не-idle клип
            let best = null, bw = 0.05;
            for (const [name, w] of this._curW) {
                if (w > bw && !(this.modeBindings[this.mode] && name === this.idleAnimName())) { best = name; bw = w; }
            }
            if (!best) best = this.idleAnimName();
            if (best && best !== this._curClipName) {
                this._curClipName = best;
                cc.masterFeet.activeAnimName = best;
                // resetOnAnimSwitch() при бленде НЕ вызываем — стопы доезжают по инерции
            }
            this.bobY = 0;
            return;
        }
        if (this.mode === 'groups') {
            let want = this.groups.idle;
            if (this.state === 'FALLING') want = this.groups.fall || this.groups.idle;
            else if (this.state === 'RUNNING') want = this.groups.run || this.groups.walk || this.groups.idle;
            else if (this.state === 'WALKING') want = this.groups.walk || this.groups.idle;
            // калибровочный клип имеет приоритет, пока batch идёт
            if (this.batchCalibrating && this.curGroup) want = this.curGroup;
            if (want && this.curGroup !== want) {
                cc.masterFeet.activeAnimName = want.name;
                cc.masterFeet.resetOnAnimSwitch();
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
//  MASTER FOOT SYSTEM — полноценный мастер-слой ног, интегрированный из двух DeepSeek-прототипов:
//
//  deepseek_html_20261028_644a29.html (Controller v71):
//   • contactUpdate / decaySpringVec3 / inerTransVec3 — инерционный spring-контакт стопы:
//     при касании точки lock (позиция фиксируется, offset переносится), при отрыве offset
//     «сбрасывается» через decay-spring — стопа плавно доезжает до новой позиции без рывков.
//   • ikTwoBone — аналитический two-bone IK (кватернионные поправки бедра/голени) с nlerp-смесью
//     по plant-весу; реализация перенесена 1-в-1 (скалярный math-слой).
//   • идеология applyWeights: плавные веса (fade-in/out), смешивание с idle, snap на переход.
//
//  deepseek_html_20261028_1c9eff.html (predictive landing XZ · stable):
//   • калибровочный профиль клипа (restAnkleOffset/minAnkleY/swingAmp/ballRestOffset/restGroundY)
//     → rawBlend = 1 − (ankleY − minAnkleY)/swingAmp, т.е. «насколько стопа ушла в опору»;
//     профили подхватываются из ik_calibration_<model>.json или считаются онлайном (batch-calib).
//   • predictLandingXZ — предиктивная посадка: экстраполяция XZ по скорости корня на время
//     переноса, 8-лучевой поиск вверх-уступа (predRadius/predRaiseThreshold), лимин offsets
//     (predMaxOffset), гистерезис прилипания (predHysteresis), soft-commit (predCommitBlend)
//     и hard-lock (predLockBlend/predLockExit) с τ-сглаживанием XZ/Y.
//   • computeInfl — смешение XZ-цели анимации с landing-точкой (predInfluence → predInfluenceAtPlant).
//   • orientFootFromToe — итеративный зонд носка (FOOT_PROBE_ITERS) + pitch-доворот стопы так,
//     чтобы подушечка (ball) стояла на рельефе без проникновения (toePenetr).
//   • компенсация таза: pelvisDeltaY = min по посаженным стопам (heelY − restGroundY), τ-сглаживание.
//   • GAIT_SPEED_K — пульс скорости мастера по фазе шага.
//
//  ЛОГИКА СМЕШЕНИЯ ВЕСОВ (мастер-слой): итоговый вес ноги =
//      ikWeight = blendSmooth (профиль) × followingScale (стабильность/ragdoll)
//                 × (1 − ragdollActive) × staggerCoef
//  — в ragdoll IK обнуляется и не мешает физике; при оглушении частично ослабевает.
//  (каскад slave-PD-весов описан в _updateStability/_followAnimation ниже)
// =================================================================================================
class MasterFootSystem {
    constructor(cc) {
        this.cc = cc;
        this.enabled = false;
        this.legs = {};                       // sideKey ('L'/'R') → состояние ноги
        this.profiles = new Map();            // animName → calibration profile
        this.defaultProfile = null;
        this.activeAnimName = '';
        this._calib = null;                   // онлайн-калибровка одного клипа
        this._batch = null;                   // очередь batch-calibration
        this.pelvisDeltaY = 0;
        this.pelvisDeltaYSmooth = 0;
        this._rootVel = new BABYLON.Vector3();
        this._rootVelSmooth = new BABYLON.Vector3();
        this._lastRootPos = null;
        this._scratchA = new BABYLON.Vector3();
        this._scratchB = new BABYLON.Vector3();
    }

    // ------------------------------------------------------------------ сборка
    setup() {
        const cc = this.cc;
        const ikOn = (cc.options.ik && cc.options.ik.enabled !== undefined)
            ? !!cc.options.ik.enabled : !!cc.params.ikEnabled;
        if (!ikOn) return;
        if (!cc.skinnedMesh || !cc.skelRef) return;

        for (const sideKey of ['L', 'R']) {
            const re = sideKey === 'L' ? /_l$|left|\.l$/i : /_r$|right|\.r$/i;
            const footRef = cc.colliderRefs.find(r => r.isFootWeld && re.test(r.name));
            if (!footRef) continue;
            const shinRef = footRef.parentRef;                 // calf
            const thighRef = shinRef ? shinRef.parentRef : null; // thigh
            if (!thighRef) continue;
            const skel = cc.skelRef;
            const findBone = (names) => {
                for (const n of names) {
                    const b = skel.bones.find(x => x.name.toLowerCase() === n.toLowerCase());
                    if (b) return b;
                }
                return null;
            };
            const suffix = sideKey === 'L' ? '_l' : '_r';
            const thigh = findBone(['upperleg' + suffix, 'thigh' + suffix, 'upper_leg' + suffix, 'UpLeg.' + sideKey]) || thighRef.bone;
            const shin = findBone(['lowerleg' + suffix, 'calf' + suffix, 'shin' + suffix, 'Leg.' + sideKey]) || shinRef.bone;
            const foot = findBone(['foot' + suffix, 'ankle' + suffix, 'Ball' + suffix, 'Foot.' + sideKey]) || footRef.bone;
            const ball = findBone(['ball' + suffix, 'toebase' + suffix, 'Ball.' + sideKey]);
            const par = thigh.getParent();

            this.legs[sideKey] = {
                sideKey, thigh, shin, foot, ball,
                pelvis: par || thigh,
                lengths: [],                     // |thigh→shin|, |shin→foot| (rest)
                contact: this.makeContactState(),
                plant: 0,                        // демпфированный целевой вес посадки
                blendSmooth: 0,                  // blend из профиля (сглаженный)
                toeGroundYSmooth: null,
                toePenetr: 0, appliedPitchDeg: 0,
                prevFootPos: null,
                landing: this.mkLanding(),
                lastIkTarget: null,
            };
            const L = this.legs[sideKey];
            thigh.computeWorldMatrix(true); shin.computeWorldMatrix(true); foot.computeWorldMatrix(true);
            L.lengths = [
                BABYLON.Vector3.Distance(thigh.getAbsolutePosition(), shin.getAbsolutePosition()),
                BABYLON.Vector3.Distance(shin.getAbsolutePosition(), foot.getAbsolutePosition()),
            ];
        }
        this.enabled = Object.keys(this.legs).length > 0;
        if (!this.enabled) return;

        // Профили калибровки: экспорт первого DeepSeek-прототипа («Predictive Landing»)
        this.loadProfiles(cc.options.calibration);
        if (cc.options.autoCalibrate !== false) this.startBatchCalibration();
    }

    loadProfiles(data) {
        if (!data) return Promise.resolve();
        const apply = (obj) => {
            if (!obj || !obj.profiles) return;
            for (const [name, p] of Object.entries(obj.profiles)) {
                if (typeof p.restAnkleOffsetL !== 'number') continue;
                this.profiles.set(name, p);
            }
            this.defaultProfile = this.profiles.get('Walk') || this.profiles.values().next().value || null;
        };
        if (typeof data === 'string') {
            return fetch(data).then(r => r.json()).then(apply).catch(() => {});
        }
        apply(data);
        return Promise.resolve();
    }

    // ------------------------------------------------------------------ контакт стопы (v71)
    makeContactState() {
        return { state: false, lock: false, position: new BABYLON.Vector3(), velocity: new BABYLON.Vector3(), point: new BABYLON.Vector3(), target: new BABYLON.Vector3(), offsetPosition: new BABYLON.Vector3(), offsetVelocity: new BABYLON.Vector3() };
    }
    // contactUpdate из v71: inState=касание → lock точки (y=footHeight), offset-перенос;
    // выход из касания/рассогласование > ur → unlock; position = source + decay-spring(offset)
    contactUpdate(cs, inPos, inState, ur, footHeightY, hl, dt) {
        const eps = 1e-8;
        const tmpX = this.cc._mfsTx || (this.cc._mfsTx = new BABYLON.Vector3());
        const tmpV = this.cc._mfsTv || (this.cc._mfsTv = new BABYLON.Vector3());
        cs.velocity.set((inPos.x - cs.target.x) / (dt + eps), (inPos.y - cs.target.y) / (dt + eps), (inPos.z - cs.target.z) / (dt + eps));
        cs.target.copyFrom(inPos);
        const srcPos = cs.lock ? cs.point : inPos;
        const srcVel = cs.lock ? this.cc._ZERO : cs.velocity;
        // inerUpdate: offset затухает пружиной, выход = источник + offset
        decaySpringToRef(cs.offsetPosition, cs.offsetVelocity, hl, dt, tmpX, tmpV);
        cs.position.set(srcPos.x + tmpX.x, srcPos.y + tmpX.y, srcPos.z + tmpX.z);
        cs.velocity.set(srcVel.x + tmpV.x, srcVel.y + tmpV.y, srcVel.z + tmpV.z);
        cs.offsetPosition.copyFrom(tmpX);
        cs.offsetVelocity.copyFrom(tmpV);
        const unlock = cs.lock && BABYLON.Vector3.Distance(cs.point, inPos) > ur;
        if (!cs.state && inState) {
            cs.lock = true;
            cs.point.copyFrom(cs.position);
            cs.point.y = footHeightY;
            // inerTrans(source=inPos,inVel → dest=point,0): offset = (src+off)−dest
            cs.offsetPosition.set(cs.position.x + cs.offsetPosition.x - cs.point.x, cs.position.y + cs.offsetPosition.y - cs.point.y, cs.position.z + cs.offsetPosition.z - cs.point.z);
            cs.offsetVelocity.set(cs.velocity.x + cs.offsetVelocity.x, cs.velocity.y + cs.offsetVelocity.y, cs.velocity.z + cs.offsetVelocity.z);
        } else if ((cs.lock && cs.state && !inState) || unlock) {
            cs.lock = false;
            // inerTrans(source=point,0 → dest=inPos,inVel)
            cs.offsetPosition.set(cs.point.x - inPos.x, cs.point.y - inPos.y, cs.point.z - inPos.z);
            cs.offsetVelocity.set(-cs.velocity.x, -cs.velocity.y, -cs.velocity.z);
        }
        cs.state = inState;
    }

    // ------------------------------------------------------------------ two-bone IK (v71, 1-в-1)
    ikTwoBone(a, b, c, t, fwd, ag, bg, pg, mxBuf) {
        const vSub = (x, y) => ({ x: x.x - y.x, y: x.y - y.y, z: x.z - y.z });
        const vAdd = (x, y) => ({ x: x.x + y.x, y: x.y + y.y, z: x.z + y.z });
        const vMul = (x, s) => ({ x: x.x * s, y: x.y * s, z: x.z * s });
        const vLen = (x) => Math.sqrt(x.x * x.x + x.y * x.y + x.z * x.z);
        const vDot = (x, y) => x.x * y.x + x.y * y.y + x.z * y.z;
        const vCross = (x, y) => ({ x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x });
        const vNorm = (x, eps = 1e-8) => { const l = vLen(x) + eps; return { x: x.x / l, y: x.y / l, z: x.z / l }; };
        const cf = (x) => x > 1 ? 1 : x < -1 ? -1 : x;
        const maxE = vLen(vSub(a, b)) + vLen(vSub(b, c)) - mxBuf;
        let tC = t;
        if (vLen(vSub(t, a)) > maxE) tC = vAdd(a, vMul(vNorm(vSub(t, a)), maxE));
        const axisRot = vNorm(vCross(vNorm(vSub(c, a)), fwd));
        const lab = vLen(vSub(b, a)), lcb = vLen(vSub(b, c)), lat = vLen(vSub(tC, a));
        const acAb0 = Math.acos(cf(vDot(vNorm(vSub(c, a)), vNorm(vSub(b, a)))));
        const baBc0 = Math.acos(cf(vDot(vNorm(vSub(a, b)), vNorm(vSub(c, b)))));
        const acAb1 = Math.acos(cf((lab * lab + lat * lat - lcb * lcb) / (2 * lab * lat)));
        const baBc1 = Math.acos(cf((lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb)));
        const qm = (q, p) => ({ w: p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z, x: p.w * q.x + p.x * q.w - p.y * q.z + p.z * q.y, y: p.w * q.y + p.x * q.z + p.y * q.w - p.z * q.x, z: p.w * q.z - p.x * q.y + p.y * q.x + p.z * q.w });
        const qinv = (q) => ({ w: -q.w, x: q.x, y: q.y, z: q.z });
        const mkQ = (ang, ax) => ({ w: Math.cos(ang / 2), x: ax.x * Math.sin(ang / 2), y: ax.y * Math.sin(ang / 2), z: ax.z * Math.sin(ang / 2) });
        const q0 = mkQ(acAb1 - acAb0, axisRot);
        const q1 = mkQ(baBc1 - baBc0, axisRot);
        const cA = vNorm(vSub(c, a)), tA = vNorm(vSub(tC, a));
        const ax = vNorm(vCross(cA, tA));
        const ang = Math.acos(cf(vDot(cA, tA)));
        const q2 = mkQ(ang, ax);
        return { boneRootLr: qm(qinv(pg), qm(q2, qm(q0, ag))), boneMidLr: qm(qinv(ag), qm(q1, bg)) };
    }
    qNlerp(a, b, t) {
        let bw = b.w, bx = b.x, by = b.y, bz = b.z;
        const d = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
        if (d < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; }
        const w = a.w + (bw - a.w) * t, x = a.x + (bx - a.x) * t, y = a.y + (by - a.y) * t, z = a.z + (bz - a.z) * t;
        const l = Math.sqrt(w * w + x * x + y * y + z * z) + 1e-8;
        return { w: w / l, x: x / l, y: y / l, z: z / l };
    }
    boneWorld(b) {
        try {
            const m = b.getWorldMatrix();
            m.decompose(this.cc._mfsDs || (this.cc._mfsDs = new BABYLON.Vector3()), this.cc._mfsDq || (this.cc._mfsDq = new BABYLON.Quaternion()), this.cc._mfsDp || (this.cc._mfsDp = new BABYLON.Vector3()));
            const q = this.cc._mfsDq, p = this.cc._mfsDp;
            return { pos: { x: p.x, y: p.y, z: p.z }, rot: { x: q.x, y: q.y, z: q.z, w: q.w } };
        } catch (_) { return null; }
    }
    boneLocal(b) {
        const q = b.rotationQuaternion;
        if (q) return { x: q.x, y: q.y, z: q.z, w: q.w };
        const e = b.rotation;
        const qq = BABYLON.Quaternion.FromEulerAngles(e.x, e.y, e.z);
        return { x: qq.x, y: qq.y, z: qq.z, w: qq.w };
    }

    // ------------------------------------------------------------------ landing state (1c9eff)
    mkLanding() { return { x: 0, y: 0, z: 0, valid: false, locked: false }; }

    rayDown(x, fromY, z, len) {
        const cc = this.cc;
        const ray = cc._mfsRay || (cc._mfsRay = new BABYLON.Ray(new BABYLON.Vector3(), new BABYLON.Vector3(0, -1, 0), 4));
        ray.origin.set(x, fromY, z);
        ray.direction.set(0, -1, 0);
        ray.length = len;
        const pick = cc.scene.pickWithRay(ray, cc.supportPredicate);
        return (pick && pick.hit && pick.pickedPoint) ? pick.pickedPoint.y : null;
    }

    // ------------------------------------------------------------------ предиктивная посадка (1c9eff, port)
    predictLandingXZ(L, dt, rootVel, cycleDur) {
        const P = this.cc.params;
        const ankle = L.foot.getAbsolutePosition();
        const blend = L.blendSmooth;
        const ld = L.landing;

        // Hard lock at plant (с гистерезисом выхода)
        if (blend >= P.predLockBlend || (ld.locked && blend >= P.predLockExit)) {
            if (ld.valid) {
                const r = this.rayDown(ld.x, ankle.y + 1.5, ld.z, 4.0);
                if (r !== null) ld.y += (r - ld.y) * dampF(dt, P.predSmoothTauY);
            }
            ld.locked = true;
            return ld;
        }
        ld.locked = false;

        // Soft commit: XZ заморожен, Y обновляется
        if (blend >= P.predCommitBlend && ld.valid) {
            const r = this.rayDown(ld.x, ankle.y + 1.5, ld.z, 4.0);
            if (r !== null) ld.y += (r - ld.y) * dampF(dt, P.predSmoothTauY);
            return ld;
        }

        // Free search: экстраполяция по скорости корня на оставшееся время переноса
        const swingDur = Math.max(0.10, 0.4 * (cycleDur || 1.2));
        const timeToLand = clampF(1 - blend, 0, 1) * swingDur;
        let gx = ankle.x + rootVel.x * timeToLand;
        let gz = ankle.z + rootVel.z * timeToLand;

        const hip = L.thigh.getAbsolutePosition();
        const dx = gx - hip.x, dz = gz - hip.z;
        const horiz = Math.hypot(dx, dz);
        const totalLen = L.lengths[0] + L.lengths[1];
        const maxH = totalLen * 0.85;
        if (horiz > maxH && horiz > 1e-6) { gx = hip.x + (dx / horiz) * maxH; gz = hip.z + (dz / horiz) * maxH; }

        let bestX = gx, bestZ = gz, bestY = null;
        const baseY = this.rayDown(gx, ankle.y + 1.5, gz, 4.0);
        if (baseY !== null) bestY = baseY;
        for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            const px = gx + Math.cos(ang) * P.predRadius;
            const pz = gz + Math.sin(ang) * P.predRadius;
            const hy = this.rayDown(px, ankle.y + 1.5, pz, 4.0);
            if (hy === null) continue;
            if (bestY === null || hy > bestY + P.predRaiseThreshold) { bestY = hy; bestX = px; bestZ = pz; }
        }
        if (bestY === null) return ld;

        // Гистерезис: близко к текущей точке — прилипаем к ней
        if (ld.valid) {
            const dCur = Math.hypot(bestX - ld.x, bestZ - ld.z);
            if (dCur < P.predHysteresis) {
                const r = this.rayDown(ld.x, ankle.y + 1.5, ld.z, 4.0);
                if (r !== null) { bestX = ld.x; bestZ = ld.z; bestY = r; }
            }
        }
        // Ограничение смещения + повторный замер Y
        const offX = bestX - ankle.x, offZ = bestZ - ankle.z;
        const offLen = Math.hypot(offX, offZ);
        if (offLen > P.predMaxOffset && offLen > 1e-6) {
            const k = P.predMaxOffset / offLen;
            bestX = ankle.x + offX * k; bestZ = ankle.z + offZ * k;
            const r = this.rayDown(bestX, ankle.y + 1.5, bestZ, 4.0);
            if (r !== null) bestY = r;
        }
        if (!ld.valid) {
            ld.x = bestX; ld.z = bestZ; ld.y = bestY; ld.valid = true;
        } else {
            const kXZ = dampF(dt, P.predSmoothTauXZ);
            ld.x += (bestX - ld.x) * kXZ;
            ld.z += (bestZ - ld.z) * kXZ;
            const kY = dampF(dt, P.predSmoothTauY);
            ld.y += (bestY - ld.y) * kY;
        }
        return ld;
    }

    computeInfluence(blend) {
        const P = this.cc.params;
        const t = clampF(blend, 0, 1);
        if (t <= P.predLockBlend) {
            return t * t * (3 - 2 * t) * P.predInfluence;
        }
        const k = (t - P.predLockBlend) / (1 - P.predLockBlend);
        return P.predInfluence + (P.predInfluenceAtPlant - P.predInfluence) * k;
    }

    // ------------------------------------------------------------------ ориентация стопы по подушечке (1c9eff, port)
    orientFootFromToe(L, blend, ballRestOffset) {
        const P = this.cc.params;
        const footTn = L.foot, ballTn = L.ball;
        L.appliedPitchDeg = 0; L.toePenetr = 0;
        if (!ballTn || blend <= 0.01) return;
        footTn.computeWorldMatrix(true);
        ballTn.computeWorldMatrix(true);
        const ankleW = footTn.getAbsolutePosition();
        const ballW = ballTn.getAbsolutePosition();
        const dx = ballW.x - ankleW.x, dz = ballW.z - ankleW.z;
        const horizLen = Math.hypot(dx, dz);
        const Ln = Math.hypot(dx, dz, ballW.y - ankleW.y);
        if (Ln < 1e-5) return;
        let hx, hz;
        if (horizLen > Ln * 0.3) { hx = dx / horizLen; hz = dz / horizLen; }
        else { const f = this.cc.masterForwardXZ(); hx = f.x; hz = f.z; }

        // Итеративный зонд: куда опустить «виртуальный носок», чтобы ball коснулся рельефа
        let d = Ln * 0.9;
        for (let iter = 0; iter < 3; iter++) {
            const px = ankleW.x + hx * d, pz = ankleW.z + hz * d;
            const gy = this.rayDown(px, ankleW.y + 1.5, pz, 4.0);
            if (gy === null) break;
            const targetBallY = gy + ballRestOffset;
            const dy = ankleW.y - targetBallY;
            const sinPitch = clampF(dy / Ln, -1, 1);
            const cosPitch = Math.sqrt(Math.max(0, 1 - sinPitch * sinPitch));
            const newD = Math.max(Ln * 0.3, Ln * cosPitch);
            if (Math.abs(newD - d) < 0.002) { d = newD; break; }
            d = newD;
        }
        const probeX = ankleW.x + hx * d, probeZ = ankleW.z + hz * d;
        const toeRaw = this.rayDown(probeX, ankleW.y + 1.5, probeZ, 4.0);
        if (toeRaw !== null) {
            if (L.toeGroundYSmooth === null) L.toeGroundYSmooth = toeRaw;
            else L.toeGroundYSmooth += (toeRaw - L.toeGroundYSmooth) * dampF(this._lastDt || 0.016, 0.06);
        }
        const toeY = L.toeGroundYSmooth;
        if (toeY === null) return;
        L.toePenetr = (toeY + ballRestOffset) - ballW.y;

        const dyNorm = clampF((toeY + ballRestOffset - ankleW.y) / Ln, -1, 1);
        const hComp = Math.sqrt(Math.max(0, 1 - dyNorm * dyNorm));
        const desiredDir = new BABYLON.Vector3(hx * hComp, dyNorm, hz * hComp);
        const currentDir = new BABYLON.Vector3(dx / Ln, (ballW.y - ankleW.y) / Ln, dz / Ln);
        const cosA = clampF(BABYLON.Vector3.Dot(currentDir, desiredDir), -1, 1);
        const pitchRad = Math.acos(cosA);
        L.appliedPitchDeg = pitchRad * 180 / Math.PI * blend;
        if (pitchRad < 1e-5) return;
        const axis = BABYLON.Vector3.Cross(currentDir, desiredDir);
        if (axis.lengthSquared() < 1e-10) return;
        axis.normalize();
        const appliedAngle = pitchRad * blend;
        const deltaQ = BABYLON.Quaternion.RotationAxis(axis, appliedAngle);
        const parentWQ = footTn.parent ? footTn.parent.getWorldMatrix().clone() : BABYLON.Quaternion.Identity();
        // world-кватернион родителя извлекаем корректно:
        const decS = new BABYLON.Vector3(), decQ = new BABYLON.Quaternion(), decP = new BABYLON.Vector3();
        (footTn.parent ? footTn.parent.getWorldMatrix() : BABYLON.Matrix.Identity()).decompose(decS, decQ, decP);
        const qAnimLocal = footTn.rotationQuaternion ? footTn.rotationQuaternion.clone() : BABYLON.Quaternion.FromEulerVector(footTn.rotation.clone());
        const qAnimWorld = decQ.multiply(qAnimLocal);
        const qTargetWorld = deltaQ.multiply(qAnimWorld);
        const parentInv = decQ.clone().invert ? decQ.clone().invert() : decQ.conjugate();
        footTn.rotationQuaternion = parentInv.multiply(qTargetWorld);
        footTn.computeWorldMatrix(true);
    }

    // ------------------------------------------------------------------ компенсация таза (1c9eff, port)
    applyPelvisDeltaWorldY(pelvis, dy) {
        if (!pelvis || Math.abs(dy) < 1e-5) return;
        const decS = new BABYLON.Vector3(), decQ = new BABYLON.Quaternion(), decP = new BABYLON.Vector3();
        (pelvis.parent ? pelvis.parent.getWorldMatrix() : BABYLON.Matrix.Identity()).decompose(decS, decQ, decP);
        const mat = BABYLON.Matrix.Identity();
        BABYLON.Matrix.FromQuaternionToRef(decQ.clone().invert ? decQ.clone().invert() : decQ.conjugate(), mat);
        const localVec = BABYLON.Vector3.TransformNormal(new BABYLON.Vector3(0, dy, 0), mat);
        pelvis.position.addInPlace(localVec);
        pelvis.computeWorldMatrix(true);
    }

    // ------------------------------------------------------------------ калибровка профилей (1c9eff, port)
    startCalibration(animName) {
        const g = this.cc.animByName.get(animName);
        const dur = g ? Math.max(0.1, (g.to - g.from) / 60) : 1.0;
        const maxFrames = clampF(Math.floor(dur * 60), 15, 90);
        this._calib = {
            animName, frames: 0, maxFrames,
            L: { minAnkleY: Infinity, maxAnkleY: -Infinity, minGroundY: Infinity, minBallY: Infinity },
            R: { minAnkleY: Infinity, maxAnkleY: -Infinity, minGroundY: Infinity, minBallY: Infinity },
        };
    }
    calibrationTick() {
        const c = this._calib;
        if (!c) return;
        for (const key of ['L', 'R']) {
            const leg = this.legs[key];
            if (!leg) continue;
            leg.foot.computeWorldMatrix(true);
            const ay = leg.foot.getAbsolutePosition().y;
            const bb = this.rayDown(leg.foot.getAbsolutePosition().x, ay + 1.5, leg.foot.getAbsolutePosition().z, 4.0);
            const st = c[key];
            if (ay < st.minAnkleY) st.minAnkleY = ay;
            if (ay > st.maxAnkleY) st.maxAnkleY = ay;
            if (bb !== null && bb < st.minGroundY) st.minGroundY = bb;
            if (leg.ball) {
                leg.ball.computeWorldMatrix(true);
                const by = leg.ball.getAbsolutePosition().y;
                if (by < st.minBallY) st.minBallY = by;
            }
        }
        c.frames++;
        if (c.frames >= c.maxFrames) this.finalizeCalibration();
    }
    finalizeCalibration() {
        const c = this._calib;
        if (!c) return;
        this._calib = null;
        const okL = isFinite(c.L.minAnkleY) && isFinite(c.L.minGroundY);
        const okR = isFinite(c.R.minAnkleY) && isFinite(c.R.minGroundY);
        if (!okL || !okR) return; // не удалось — просто пропускаем
        const MIN_O = 0.01, MAX_O = 0.5;
        let offL = Math.max(MIN_O, c.L.minAnkleY - c.L.minGroundY);
        let offR = Math.max(MIN_O, c.R.minAnkleY - c.R.minGroundY);
        if (offL > MAX_O) offL = 0.05;
        if (offR > MAX_O) offR = 0.05;
        const prof = {
            restAnkleOffsetL: offL, restAnkleOffsetR: offR,
            minAnkleYL: c.L.minAnkleY, minAnkleYR: c.R.minAnkleY,
            swingAmpL: Math.max(0.02, c.L.maxAnkleY - c.L.minAnkleY),
            swingAmpR: Math.max(0.02, c.R.maxAnkleY - c.R.minAnkleY),
            ballRestOffsetL: isFinite(c.L.minBallY) ? Math.max(0, c.L.minBallY - c.L.minGroundY) : 0,
            ballRestOffsetR: isFinite(c.R.minBallY) ? Math.max(0, c.R.minBallY - c.R.minGroundY) : 0,
            restGroundY: Math.min(isFinite(c.L.minGroundY) ? c.L.minGroundY : 0, isFinite(c.R.minGroundY) ? c.R.minGroundY : 0),
        };
        this.profiles.set(c.animName, prof);
        if (!this.defaultProfile) this.defaultProfile = prof;
        this._advanceBatch();
    }
    startBatchCalibration() {
        const cc = this.cc;
        if (!this.enabled || Object.keys(this.legs).length === 0) return; // ноги ещё не собраны — см. autoStartCalibration
        const queue = [...cc.animByName.keys()].filter(n => !this.profiles.has(n));
        if (!queue.length) return;
        this._batch = { queue, idx: 0 };
        this._playMasterClip(queue[0], true);
    }
    _advanceBatch() {
        const b = this._batch;
        if (!b) return;
        b.idx++;
        if (b.idx >= b.queue.length) {
            this._batch = null;
            this._playMasterClip(this.cc.master.groups.walk ? this.cc.master.groups.walk.name : (this.cc.animByName.keys().next().value || ''), true);
            this.cc.master.batchCalibrating = false;
            return;
        }
        this._playMasterClip(b.queue[b.idx], true);
    }
    _playMasterClip(name, loop) {
        const g = this.cc.animByName.get(name);
        if (!g) return;
        try { this.cc.master.playGroup(g, loop); } catch (_) {}
    }
    getActiveProfile() {
        const name = this.activeAnimName;
        if (name && this.profiles.has(name)) return this.profiles.get(name);
        if (this._batch) return null;           // идёт калибровка — IK ждёт
        if (name && !this._calib) this.startCalibration(name);
        return this.defaultProfile || null;     // fallback на дефолтный профиль (как EXTRA_POOL в оригинале)
    }

    // ------------------------------------------------------------------ главный цикл ног мастера
    update(dt, t) {
        const cc = this.cc, P = cc.params;
        if (!this.enabled) return;
        this._lastDt = dt;

        // скорость корня мастера (для предикции) + GAIT_SPEED_K пульс (1c9eff)
        const rp = cc.master.mesh.position;
        if (this._lastRootPos && dt > 1e-5) {
            this._rootVel.set((rp.x - this._lastRootPos.x) / dt, 0, (rp.z - this._lastRootPos.z) / dt);
            const k = dampF(dt, 0.12);
            this._rootVelSmooth.x += (this._rootVel.x - this._rootVelSmooth.x) * k;
            this._rootVelSmooth.z += (this._rootVel.z - this._rootVelSmooth.z) * k;
        } else {
            this._rootVelSmooth.set(0, 0, 0);
        }
        this._lastRootPos = this._lastRootPos ? this._lastRootPos.copyFrom(rp) : rp.clone();

        // online-калибровка приоритетнее работы IK (как calibrationTick-return в оригинале)
        if (this._calib) { this.calibrationTick(); return; }

        const profile = this.getActiveProfile();
        const moving = cc.master.state === 'WALKING' || cc.master.state === 'RUNNING';
        const speedBase = moving ? (cc.master.state === 'RUNNING' ? P.runSpeed : P.walkSpeed) : 0;
        const gaitPulse = 1 + Math.sin(cc.master.walkPhase * 2) * P.gaitSpeedK; // GAIT_SPEED_K
        const cycleDur = clampF(1.2 / Math.max(0.3, speedBase * gaitPulse), 0.4, 2.5);

        const canIK = cc.slaveAlive && !cc.ragdollActive && cc.feetSupport.supportY !== null;
        let plantedOffsets = [];

        for (const key of Object.keys(this.legs)) {
            const L = this.legs[key];
            const isLeft = key === 'L';
            const footRef = cc.colliderRefs.find(r => r.isFootWeld && new RegExp(isLeft ? '_l|left' : '_r|right', 'i').test(r.name));
            if (!footRef) continue;

            try { cc.skelRef.prepare(); } catch (_) {}
            L.foot.computeWorldMatrix(true);
            const fW = L.foot.getAbsolutePosition();

            // --- blend из калибровочного профиля (1c9eff): насколько стопа ушла вниз в опору
            let rawBlend = 0;
            if (profile) {
                const minAY = isLeft ? profile.minAnkleYL : profile.minAnkleYR;
                const amp = isLeft ? profile.swingAmpL : profile.swingAmpR;
                rawBlend = clampF(1 - (fW.y - minAY) / Math.max(0.02, amp), 0, 1);
            }
            L.blendSmooth += (rawBlend - L.blendSmooth) * dampF(dt, P.masterBlendTau);

            // --- инерционный spring-контакт (v71): lock позиции при касании
            const vY = L.prevFootPos ? (fW.y - L.prevFootPos.y) / Math.max(dt, 1e-5) : 0;
            L.prevFootPos = L.prevFootPos ? L.prevFootPos.copyFrom(fW) : fW.clone();
            const supY = this.rayDown(fW.x, fW.y + 0.6, fW.z, 1.2);
            const dG = supY !== null ? (fW.y - supY) : 1;
            const isDown = (footRef.groundContacts > 0) || (dG < 0.08 && Math.abs(vY) < 0.6);
            const footHeightY = (supY !== null ? supY : 0) + (footRef.bindCenter.y - footRef.boxSize.y * 0.5) * 0 ; // низ коллайдера как точка контакта
            this.contactUpdate(L.contact, fW, isDown, P.contactUnlockRadius, (supY !== null ? supY : fW.y) + 0.03, P.contactSpringHalfLife, dt);

            // --- plant-вес: tgt=lock?1:0, τ-демпфирование (v71) + каскад mixing weights
            const tgt = L.contact.lock ? 1 : 0;
            L.plant += (tgt - L.plant) * dampF(dt, 0.06);
            if (L.plant < 0.005) L.plant = 0;
            const follow = clampF(cc.followingScale, 0, 1);
            const ikWeight = canIK ? clampF(Math.max(L.plant, L.blendSmooth * 0.8) * follow * cc.staggerCoef, 0, 1) : 0;

            // --- предиктивная посадка XZ (1c9eff)
            let land = null;
            if (P.predictive && canIK) land = this.predictLandingXZ(L, dt, this._rootVelSmooth, cycleDur);

            // influence-смешение XZ цели
            let mixX = fW.x, mixZ = fW.z;
            if (land && land.valid) {
                const infl = this.computeInfluence(L.blendSmooth);
                mixX = fW.x + (land.x - fW.x) * infl;
                mixZ = fW.z + (land.z - fW.z) * infl;
            }
            // heel-Y: из locked landing либо свежий рейкаст под смешанной точкой
            let heelY;
            if (land && land.valid && land.locked) heelY = land.y;
            else {
                const r = this.rayDown(mixX, fW.y + 1.5, mixZ, 4.0);
                heelY = r !== null ? r : fW.y;
            }
            const restOff = isLeft ? (profile ? profile.restAnkleOffsetL : 0.08) : (profile ? profile.restAnkleOffsetR : 0.08);
            const tgtYL = heelY + restOff;

            // --- коллекционируем «посаженные» стопы для компенсации таза
            const plantedBlend = P.pelvisPlantedBlend;
            if (L.blendSmooth > plantedBlend && profile) {
                plantedOffsets.push(heelY - profile.restGroundY);
            }

            // --- two-bone IK (v71) поверх скинет-скелета, вес = ikWeight
            if (ikWeight > 0.005) {
                const tW = this.boneWorld(L.thigh), sW = this.boneWorld(L.shin), fw = this.boneWorld(L.foot);
                const par = L.thigh.getParent();
                const pW = par ? this.boneWorld(par) : { pos: { x: 0, y: 0, z: 0 }, rot: { w: 1, x: 0, y: 0, z: 0 } };
                if (tW && sW && fw) {
                    const fwd = cc.masterForwardXZ();
                    const contactPos = L.contact.position;
                    const target = { x: mixX, y: tgtYL, z: mixZ };
                    // смешиваем contact-пружину и landing-цель: пружина даёт инерцию, цель — рельеф
                    const sx = contactPos.x * 0.35 + target.x * 0.65;
                    const sy = Math.max(contactPos.y * 0.35 + target.y * 0.65, tgtYL - 0.02);
                    const sz = contactPos.z * 0.35 + target.z * 0.65;
                    const res = this.ikTwoBone(tW.pos, sW.pos, fw.pos, { x: sx, y: sy, z: sz }, fwd, tW.rot, sW.rot, pW.rot, 0.02);
                    try {
                        L.thigh.setRotationQuaternion(this.qToB(this.qNlerp(this.boneLocal(L.thigh), res.boneRootLr, ikWeight)), BABYLON.Space.LOCAL);
                        L.shin.setRotationQuaternion(this.qToB(this.qNlerp(this.boneLocal(L.shin), res.boneMidLr, ikWeight)), BABYLON.Space.LOCAL);
                    } catch (_) {}
                }
            }

            // --- доворот стопы по подушечке (1c9eff)
            if (profile && canIK) {
                this.orientFootFromToe(L, ikWeight, isLeft ? profile.ballRestOffsetL : profile.ballRestOffsetR);
            }
        }

        // --- компенсация таза: min ΔY по посаженным стопам, τ-сглаживание (1c9eff)
        let pelvisTarget = this.pelvisDeltaYSmooth;
        if (P.pelvisCompensation && plantedOffsets.length > 0) {
            pelvisTarget = Math.min.apply(null, plantedOffsets);
        }
        this.pelvisDeltaYSmooth += (pelvisTarget - this.pelvisDeltaYSmooth) * dampF(dt, P.pelvisTau);
        this.pelvisDeltaY = this.pelvisDeltaYSmooth;
        if (P.pelvisCompensation && canIK && Math.abs(this.pelvisDeltaY) > 1e-4) {
            const anyLeg = this.legs[Object.keys(this.legs)[0]];
            if (anyLeg) this.applyPelvisDeltaWorldY(anyLeg.pelvis, this.pelvisDeltaY);
        }
        try { cc.skelRef.prepare(); } catch (_) {}
    }

    qToB(q) { return new BABYLON.Quaternion(q.x, q.y, q.z, q.w); }

    resetOnAnimSwitch() {
        for (const key of Object.keys(this.legs)) {
            const L = this.legs[key];
            L.blendSmooth = 0; L.toeGroundYSmooth = null; L.landing = this.mkLanding(); L.toePenetr = 0;
        }
    }

    dispose() {
        this.legs = {};
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
        this._ZERO = BABYLON.Vector3.Zero();   // общий нулевой вектор (контакты MasterFootSystem)
        this.animByName = new Map();            // name → AnimationGroup (калибровка профилей, blend-поле)
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
        this.masterFeet = new MasterFootSystem(this);

        this._observers = [];
        this._build();
    }

    // ------------------------------------------------------------------ сборка
    _build() {
        const scene = this.scene;
        this.LM = JointAxes.computeLandmarks(this.skelRef, this.skinnedMesh, this.excludeBones);

        // Мастер-ноги инициализируются ДО создания мастера: playGroup при выборе клипа
        // вызывает masterFeet.resetOnAnimSwitch(), поле должно существовать.
        const ikOnEarly = (this.options.ik && this.options.ik.enabled !== undefined)
            ? !!this.options.ik.enabled : !!this.params.ikEnabled;
        if (ikOnEarly) this.masterFeet.enabled = true;   // setup() соберёт ноги после ragdoll

        // Мастер (полупрозрачный аватар-цель)
        this.master.create(this.skinnedMesh, this.skelRef, this.animationGroups, this.LM);

        // Рагдолл-слейв
        this._createRagdoll();

        // Мастер-ноги: two-bone IK + предиктивная посадка + профили калибровки
        this.masterFeet.setup();

        // Коллизии → контакты/удары
        this._bindCollisions();
        // Ввод
        this._bindInput();

        // Главный цикл
        const syncObserver = scene.onBeforeRenderObservable.add(() => this._tick());
        this._observers.push(syncObserver);

        // Batch-калибровка профилей клипов (мастер играет клипы на месте, locomotion заморожен)
        this.autoStartCalibration();
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
        // master-layer v71: веса клипов мастера масштабируются на followingScale (плавное гашение анимации при потере стабильности),
        // в ragdoll скелет мастера замораживается в rest-позе (slave живёт только физикой).
        if (P.masterClipWeightScale && this.master.mode === 'groups' && this.master.clipMode !== 'chains') {
            const ws = clampF(this.followingScale, 0, 1);
            for (const g of this.animationGroups) {
                try {
                    if (g.weight !== undefined) g.weight = ws;
                    else for (const anim of g.animatables ?? []) if (anim.weight !== undefined) anim.weight = ws;
                } catch (_) {}
            }
        }
        if (P.freezeMasterOnRagdoll && this.ragdollActive && this.master.skeleton) {
            // rest-поза: локальные матрицы из restLocalMatrix скинета-референса неприменимы к мастеру —
            // просто ставим identity-additive поверх rest (restQuat уже сохранён в MasterController.create)
            for (const [bone, qRest] of this.master.restQuat.entries()) {
                try { bone.setRotationQuaternion(qRest, BABYLON.Space.LOCAL); } catch (_) {}
            }
            try { this.master.skeleton.computeAbsoluteMatrices(); } catch (_) {}
        }
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
        // калибровка профилей клипов (онлайн-сбор статистики + batch-очередь)
        if (this.masterFeet.enabled) {
            this.masterFeet.calibrationTick();
            if (this.master.batchCalibrating && !this.masterFeet._calib && !this.masterFeet._batch) {
                this.master.batchCalibrating = false;   // очередь пуста — возвращаем locomotion
            }
        }

        // 3) Slave: веса → приводы → баланс → IK
        if (this.activeEnabled) {
            this._updateReactions(dt);
            this._updateStability(dt);
            this._updateSlaveController(dt);
            this._followAnimation(dt);
            this._applyBalance(dt);
            this.masterFeet.update(dt, t);
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
    // world-forward мастера по XZ (используется MasterFootSystem для предикции посадки)
    masterForwardXZ() {
        const fv = this.master.forwardVec || BABYLON.Vector3.Forward();
        return { x: fv.x, z: fv.z };
    }
    // Запуск пакетной калибровки профилей всех клипов (идея 1c9eff): мастер играет клипы на месте
    startCalibrationBatch() {
        this.master.batchCalibrating = true;
        this.masterFeet.startBatchCalibration();
    }

    setIntent(dirVector3, running = false) {
        this.externalIntent = dirVector3 && dirVector3.lengthSquared() > 1e-6
            ? { dir: new BABYLON.Vector3(dirVector3.x, 0, dirVector3.z), running }
            : null;
    }
    clearIntent() { this.externalIntent = null; }
    setSpeedLimit(v) { this.externalSpeedLimit = v; }
    // Автозапуск batch-калибровки после полной сборки контроллера
    autoStartCalibration() {
        if (this.options.autoCalibrate !== false && this.masterFeet.enabled) this.masterFeet.startBatchCalibration();
    }

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
            masterRamp: this.master._ramp ?? 0,
            // v71-телеметрия цепей/блендинга
            locoMode: this.master.mode || 'loco',
            clipMode: this.master.clipMode || 'procedural',
            valueFwd: this.master.valueFwd ?? 0,
            valueSide: this.master.valueSide ?? 0,
            sprintT: this.master.sprintT ?? 0,
            slopeGrad: this.master.slopeGrad ?? 0,
            zoneMul: this.master.zoneMul ?? 1,
            chains: Object.fromEntries(Object.entries(this.master.chains || {}).map(([k, v]) => [k, v.length])),
            blendWeights: (() => { const o = {}; for (const [n, w] of (this.master._curW || [])) if (w > 0.02) o[n] = +w.toFixed(2); return o; })(),
            calibrating: !!this.master.batchCalibrating,
            calibratedProfiles: this.masterFeet.profiles.size,
        };
    }

    dispose() {
        for (const o of this._observers) { try { this.scene.onBeforeRenderObservable.remove(o); } catch (_) {} try { this.physicsEngine.onCollisionObservable.remove(o); } catch (_) {} }
        this._observers = [];
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        if (this._onPointerDown) this.scene.getEngine().getRenderingCanvas().removeEventListener('pointerdown', this._onPointerDown);
        if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
        this.masterFeet.dispose();
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
