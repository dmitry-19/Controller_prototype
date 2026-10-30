// js/ragdollPhysics.js
import { STATE_NAMES } from './stateMachine.js';

/**
 * Возвращает угловые ограничения для кости по её имени.
 * @param {string} boneName - Имя кости.
 * @returns {Array} Массив ограничений { axis, min, max } в радианах.
 */
function getAngularLimits(boneName) {
    const name = boneName.toLowerCase();

    if (name.includes('root') || name.includes('pelvis')) {
        return [
            { axis: 0, min: -3 * Math.PI / 180, max: 3 * Math.PI / 180 },
            { axis: 1, min: -8 * Math.PI / 180, max: 8 * Math.PI / 180 },
            { axis: 2, min: -3 * Math.PI / 180, max: 3 * Math.PI / 180 }
        ];
    }
    if (name.includes('spine_01')) {
        return [
            { axis: 0, min: -6 * Math.PI / 180, max: 6 * Math.PI / 180 },
            { axis: 1, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 },
            { axis: 2, min: -6 * Math.PI / 180, max: 6 * Math.PI / 180 }
        ];
    }
    if (name.includes('spine_02')) {
        return [
            { axis: 0, min: -8 * Math.PI / 180, max: 8 * Math.PI / 180 },
            { axis: 1, min: -12 * Math.PI / 180, max: 12 * Math.PI / 180 },
            { axis: 2, min: -8 * Math.PI / 180, max: 8 * Math.PI / 180 }
        ];
    }
    if (name.includes('spine_03')) {
        return [
            { axis: 0, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 },
            { axis: 1, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 },
            { axis: 2, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 }
        ];
    }
    if (name.includes('neck_01')) {
        return [
            { axis: 0, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 },
            { axis: 1, min: -30 * Math.PI / 180, max: 30 * Math.PI / 180 },
            { axis: 2, min: -20 * Math.PI / 180, max: 20 * Math.PI / 180 }
        ];
    }
    if (name.includes('head')) {
        return [
            { axis: 0, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 },
            { axis: 1, min: -20 * Math.PI / 180, max: 20 * Math.PI / 180 },
            { axis: 2, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 }
        ];
    }
    if (name.includes('clavicle')) {
        return [
            { axis: 0, min: -8 * Math.PI / 180, max: 8 * Math.PI / 180 },
            { axis: 1, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 },
            { axis: 2, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 }
        ];
    }
    // Плечо – большой диапазон, но с ограничением вращения вокруг продольной оси
    if (name.includes('upperarm')) {
        return [
            { axis: 0, min: -70 * Math.PI / 180, max: 70 * Math.PI / 180 },
            { axis: 1, min: -50 * Math.PI / 180, max: 50 * Math.PI / 180 },
            { axis: 2, min: -40 * Math.PI / 180, max: 40 * Math.PI / 180 }
        ];
    }
    // Локоть – только сгибание (ось Z) и очень маленькие остальные движения
    if (name.includes('lowerarm')) {
        return [
            { axis: 0, min: 0, max: 0 },
            { axis: 1, min: 0, max: 0 },
            { axis: 2, min: 0, max: 130 * Math.PI / 180 } // сгибание от 0 до 130°
        ];
    }
    // Запястье – небольшие углы
    if (name.includes('hand')) {
        return [
            { axis: 0, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 },
            { axis: 1, min: -20 * Math.PI / 180, max: 20 * Math.PI / 180 },
            { axis: 2, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 }
        ];
    }
    // Пальцы – минимальная подвижность
    if (name.includes('middle_01') || name.includes('index_01') || name.includes('pinky_01') || name.includes('ring_01') || name.includes('thumb_01')) {
        return [
            { axis: 0, min: -5 * Math.PI / 180, max: 5 * Math.PI / 180 },
            { axis: 1, min: -5 * Math.PI / 180, max: 5 * Math.PI / 180 },
            { axis: 2, min: 0, max: 30 * Math.PI / 180 }
        ];
    }
    // Бедро – хорошая подвижность, но без вывихов
    if (name.includes('thigh')) {
        return [
            { axis: 0, min: -70 * Math.PI / 180, max: 70 * Math.PI / 180 },
            { axis: 1, min: -35 * Math.PI / 180, max: 35 * Math.PI / 180 },
            { axis: 2, min: -25 * Math.PI / 180, max: 25 * Math.PI / 180 }
        ];
    }
    // Колено – только сгибание
    if (name.includes('calf')) {
        return [
            { axis: 0, min: 0, max: 120 * Math.PI / 180 },
            { axis: 1, min: 0, max: 0 },
            { axis: 2, min: 0, max: 0 }
        ];
    }
    // Стопа – небольшие углы
    if (name.includes('foot')) {
        return [
            { axis: 0, min: -20 * Math.PI / 180, max: 20 * Math.PI / 180 },
            { axis: 1, min: -15 * Math.PI / 180, max: 15 * Math.PI / 180 },
            { axis: 2, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 }
        ];
    }
    // Пальцы ног – минимальные
    if (name.includes('ball')) {
        return [
            { axis: 0, min: -10 * Math.PI / 180, max: 10 * Math.PI / 180 },
            { axis: 1, min: -5 * Math.PI / 180, max: 5 * Math.PI / 180 },
            { axis: 2, min: -5 * Math.PI / 180, max: 5 * Math.PI / 180 }
        ];
    }

    // Для остальных костей – почти полная блокировка
    return [
        { axis: 0, min: -1 * Math.PI / 180, max: 1 * Math.PI / 180 },
        { axis: 1, min: -1 * Math.PI / 180, max: 1 * Math.PI / 180 },
        { axis: 2, min: -1 * Math.PI / 180, max: 1 * Math.PI / 180 }
    ];
}

export function buildRagdollConfig(skeleton, skinnedMesh) {
    const positions = skinnedMesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const weights = skinnedMesh.getVerticesData(BABYLON.VertexBuffer.MatricesWeightsKind);
    const indices = skinnedMesh.getVerticesData(BABYLON.VertexBuffer.MatricesIndicesKind);
    if (!positions || !weights || !indices) throw new Error("Нет данных весов");

    const vertices = [];
    for (let i = 0; i < positions.length; i += 3) {
        vertices.push(new BABYLON.Vector3(positions[i], positions[i + 1], positions[i + 2]));
    }

    const boneVerts = new Array(skeleton.bones.length).fill().map(() => []);
    for (let i = 0; i < weights.length; i += 4) {
        let maxW = 0, maxIdx = -1;
        for (let j = 0; j < 4; j++) {
            const w = weights[i + j];
            const idx = indices[i + j];
            if (w > maxW && idx < skeleton.bones.length) {
                maxW = w;
                maxIdx = idx;
            }
        }
        if (maxIdx >= 0) boneVerts[maxIdx].push(i / 4);
    }

    const rootBone = skeleton.bones.find(b => !b.parent) || skeleton.bones[0];
    const configs = [];

    skeleton.bones.forEach((bone, idx) => {
        const verts = boneVerts[idx] || [];
        const invMatrix = bone.getAbsoluteMatrix().clone().invert();
        let min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
        let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);

        if (verts.length === 0) {
            min = new BABYLON.Vector3(-0.08, -0.08, -0.08);
            max = new BABYLON.Vector3(0.08, 0.08, 0.08);
        } else {
            verts.forEach(vIdx => {
                const worldPos = vertices[vIdx];
                const localPos = BABYLON.Vector3.TransformCoordinates(worldPos, invMatrix);
                min = BABYLON.Vector3.Minimize(min, localPos);
                max = BABYLON.Vector3.Maximize(max, localPos);
            });
        }

        const size = max.subtract(min);
        const SCALE = 0.45;
        let w = Math.max(size.x * SCALE, 0.12);
        let h = Math.max(size.y * SCALE, 0.12);
        let d = Math.max(size.z * SCALE, 0.12);

        const boneName = bone.name.toLowerCase();
        if (boneName.includes('head')) w = h = d = 0.18;
        if (boneName.includes('hand')) { w = 0.1; h = 0.1; d = 0.08; }
        if (boneName.includes('foot')) { w = 0.15; h = 0.08; d = 0.2; }
        if (boneName.includes('clavicle')) { w = 0.15; h = 0.08; d = 0.15; }

        // Массы подобраны для устойчивости: таз самый тяжёлый, конечности легче
        let mass;
        if (bone === rootBone) mass = 60;    // таз/корень
        else if (boneName.includes('pelvis')) mass = 50;
        else if (boneName.includes('spine_01') || boneName.includes('spine_02') || boneName.includes('spine_03')) mass = 15;
        else if (boneName.includes('thigh')) mass = 8;
        else if (boneName.includes('upperarm')) mass = 6;
        else if (boneName.includes('calf')) mass = 4;
        else if (boneName.includes('lowerarm')) mass = 3;
        else if (boneName.includes('hand')) mass = 1;
        else if (boneName.includes('foot')) mass = 1.5;
        else if (boneName.includes('head')) mass = 3;
        else mass = Math.min(10, Math.max(1, w * h * d * 600));

        const angularLimits = getAngularLimits(bone.name);

        configs.push({
            bones: [bone.name],
            mass,
            width: w,
            height: h,
            depth: d,
            angularLimits
        });
    });

    if (!configs.some(cfg => cfg.bones.includes(rootBone.name))) {
        configs.push({
            bones: [rootBone.name],
            mass: 60,
            width: 0.35,
            height: 0.35,
            depth: 0.35,
            angularLimits: getAngularLimits(rootBone.name)
        });
    }

    return { configs, rootBone };
}

export function stabilizeBodies(boneBodyMap) {
    boneBodyMap.forEach(body => {
        body.setLinearDamping?.(0.9);
        body.setAngularDamping?.(0.9);
        body.setSleepThreshold?.(0.2);

        const shape = body.shape;
        if (shape) {
            shape.filterMembershipMask = 1 << 2;
            shape.filterCollideMask = -1;
        }

        body.tag = "ragdollPart";
        body.setCollisionCallbackEnabled(true);
    });
}

export function createClavicleStabilizer(boneBodyMap, scene) {
    const leftClav = boneBodyMap.get('clavicle_l');
    const rightClav = boneBodyMap.get('clavicle_r');
    if (!leftClav || !rightClav) {
        console.warn("Ключицы не найдены, стабилизатор не создан");
        return;
    }
    if (typeof leftClav.addConstraint !== 'function') {
        console.warn("Метод addConstraint не найден. Возможно, используется устаревшая версия физики.");
        return;
    }

    const posL = leftClav.transformNode.getAbsolutePosition();
    const posR = rightClav.transformNode.getAbsolutePosition();
    const restLength = BABYLON.Vector3.Distance(posL, posR);
    const minDistance = restLength * 0.9;
    const maxDistance = restLength * 1.1;
    const stiffness = 200;
    const damping = 15;

    try {
        const constraint = new BABYLON.Physics6DoFConstraint(
            { pivotA: BABYLON.Vector3.Zero(), pivotB: BABYLON.Vector3.Zero() },
            [{
                axis: BABYLON.PhysicsConstraintAxis.LINEAR_DISTANCE,
                minLimit: minDistance,
                maxLimit: maxDistance,
                stiffness: stiffness,
                damping: damping
            }],
            scene
        );
        try { constraint.isCollisionsEnabled = false; } catch (e) {}
        leftClav.addConstraint(rightClav, constraint);
        console.log(`Стабилизатор ключиц создан, длина = ${restLength.toFixed(3)}`);
    } catch (e) {
        console.error("Ошибка при создании стабилизатора ключиц:", e);
    }
}

export function createSpringConstraint(bodyA, bodyB, pivotA, pivotB, config, scene) {
    if (!bodyA || !bodyB || typeof bodyA.addConstraint !== 'function') {
        console.warn("createSpringConstraint: addConstraint не доступен");
        return null;
    }
    const { stiffness = 400, damping = 50, restLength = null, minDistance = 0, maxDistance = Infinity, collisionEnabled = false } = config;
    try {
        if (restLength === null) {
            const posA = bodyA.transformNode.getAbsolutePosition();
            const posB = bodyB.transformNode.getAbsolutePosition();
            restLength = BABYLON.Vector3.Distance(posA, posB);
        }
        const constraint = new BABYLON.Physics6DoFConstraint(
            { pivotA: pivotA || BABYLON.Vector3.Zero(), pivotB: pivotB || BABYLON.Vector3.Zero() },
            [
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0, stiffness, damping },
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0, stiffness, damping },
                { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0, stiffness, damping }
            ],
            scene
        );
        constraint.isCollisionsEnabled = collisionEnabled;
        bodyA.addConstraint(bodyB, constraint);
        return constraint;
    } catch (e) {
        console.error("Ошибка при создании пружины:", e);
        return null;
    }
}

export function createDistanceSpring(bodyA, bodyB, config, scene) {
    if (!bodyA || !bodyB || typeof bodyA.addConstraint !== 'function') return null;
    const { stiffness = 500, damping = 30, restLength = null, minDistanceRatio = 0.8, maxDistanceRatio = 1.2 } = config;
    try {
        const posA = bodyA.transformNode.getAbsolutePosition();
        const posB = bodyB.transformNode.getAbsolutePosition();
        const actualRestLength = restLength || BABYLON.Vector3.Distance(posA, posB);
        const minDistance = actualRestLength * minDistanceRatio;
        const maxDistance = actualRestLength * maxDistanceRatio;
        const constraint = new BABYLON.Physics6DoFConstraint(
            { pivotA: BABYLON.Vector3.Zero(), pivotB: BABYLON.Vector3.Zero() },
            [{
                axis: BABYLON.PhysicsConstraintAxis.LINEAR_DISTANCE,
                minLimit: minDistance,
                maxLimit: maxDistance,
                stiffness,
                damping
            }],
            scene
        );
        constraint.isCollisionsEnabled = false;
        bodyA.addConstraint(bodyB, constraint);
        return constraint;
    } catch (e) {
        console.error("Ошибка при создании distance spring:", e);
        return null;
    }
}

// ==================== ReactionSystem ====================
const MIN_FORCE_THRESHOLD = 2.0; // порог силы, ниже которого удар игнорируется

export class ReactionSystem {
    constructor(markers, boneBodyMap, upTargets, root, movementSystem, stateMachine, animManager, staminaSystem, autonomousBehaviour = null, healthSystem = null) {
        this.markers = markers;
        this.boneBodyMap = boneBodyMap;
        this.upTargets = upTargets;
        this.root = root;
        this.movement = movementSystem;
        this.stateMachine = stateMachine;
        this.animManager = animManager;
        this.stamina = staminaSystem;
        this.autonomous = autonomousBehaviour;
        this.healthSystem = healthSystem;
        this.hitQueue = [];
    }

    getHitZone(boneName) {
        const name = boneName.toLowerCase();
        if (name.includes('head')) return 'head';
        if (name.includes('neck')) return 'neck';
        if (name.includes('spine') || name.includes('chest')) return 'torso';
        if (name.includes('pelvis')) return 'pelvis';
        if (name.includes('thigh') || name.includes('calf') || name.includes('foot')) return 'leg';
        if (name.includes('upperarm') || name.includes('lowerarm') || name.includes('hand')) return 'arm';
        return 'other';
    }

    registerHit(hitData) {
        this.hitQueue.push(hitData);
    }

    processHits() {
        if (this.hitQueue.length === 0) return;

        let maxForceHit = null;
        let maxForce = 0;
        for (let hit of this.hitQueue) {
            if (hit.force > maxForce) {
                maxForce = hit.force;
                maxForceHit = hit;
            }
        }
        this.hitQueue = [];

        if (!maxForceHit) return;
        const { force, point, normal, bodyPart, body } = maxForceHit;

        // Игнорируем слабые касания
        if (force < MIN_FORCE_THRESHOLD) {
            return;
        }

        const zone = this.getHitZone(bodyPart);
        console.log(`[Reaction] hit ${zone} (${bodyPart}) force ${force.toFixed(1)}`);

        if (this.healthSystem) {
            this.healthSystem.takeDamage(force, zone);
        } else if (this.stamina) {
            this.stamina.consumeByImpact(force);
        }

        this.markers.forEach(m => { if (m.material) m.material.emissiveColor = new BABYLON.Color3(1, 0, 0); });
        setTimeout(() => {
            this.markers.forEach(m => { if (m.material) m.material.emissiveColor = new BABYLON.Color3(0, 1, 0); });
        }, 100);

        const curState = this.stateMachine?.currentState?.name;
        if (curState === STATE_NAMES.KNOCKDOWN || curState === STATE_NAMES.RAGDOLL || curState === STATE_NAMES.GET_UP) return;

        // Импульс физическому телу (уменьшен)
        if (body) {
            body.applyImpulse(normal.scale(force * 0.3), point);
        }

        // Запись в автономное поведение только для значительных ударов
        if (this.autonomous && force > MIN_FORCE_THRESHOLD) {
            this.autonomous.recordDanger('generic', 'impact', zone, force);
        }

        const isLow = this.stamina?.isLow || false;
        const isExhausted = this.stamina?.isExhausted || false;

        if (isExhausted && force > 15) {
            this.stateMachine.transitionTo(STATE_NAMES.RAGDOLL_IMPACT, { direction: normal, force, contactPoint: point });
        } else if (isLow && force > 10) {
            this.stateMachine.transitionTo(STATE_NAMES.STUMBLE, { direction: normal, force, contactPoint: point });
        } else if (force > 20) {
            const hitZone = this.getHitZone(bodyPart);
            const level = force > 50 ? 3 : (force > 30 ? 2 : 1);
            this.stateMachine.transitionTo(STATE_NAMES.IMPACT, { level, hitZone, force });
        }
    }

    // --- Проверка баланса (расхождение кинематики и физики) ---
    checkBalance(markers, boneBodyMap, pdStrength) {
        // Не проверяем баланс, если персонаж выполняет уклонение/отступление
        if (this.movement?.isEvading) {
            return;
        }

        const curState = this.stateMachine?.currentState?.name;
        if (curState === STATE_NAMES.RAGDOLL ||
            curState === STATE_NAMES.RAGDOLL_IMPACT ||
            curState === STATE_NAMES.KNOCKDOWN ||
            curState === STATE_NAMES.GET_UP) {
            return;
        }

        const staminaMultiplier = this.stamina ? this.stamina.getPdStrengthMultiplier() : 1.0;
        const baseThreshold = 1.2;
        const threshold = baseThreshold * staminaMultiplier;

        const bonesToCheck = ['pelvis', 'spine_03', 'thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r'];
        let maxError = 0;
        let maxErrorDirection = new BABYLON.Vector3(0, 0, 0);
        let maxErrorBody = null;

        for (const marker of markers) {
            const boneName = marker.name.replace('marker_', '');
            if (!bonesToCheck.includes(boneName)) continue;
            const physBody = boneBodyMap.get(boneName);
            if (!physBody) continue;

            const targetPos = marker.getAbsolutePosition();
            const currentPos = physBody.transformNode.getAbsolutePosition();
            const error = targetPos.subtract(currentPos);
            const dist = error.length();

            if (dist > maxError) {
                maxError = dist;
                maxErrorDirection = error.normalize();
                maxErrorBody = physBody;
            }
        }

        if (maxError > threshold && maxErrorBody) {
            const force = maxError * 30;
            if (this.stamina) {
                this.stamina.consumeByImpact(force);
            }
            this.stateMachine.transitionTo(STATE_NAMES.RAGDOLL_IMPACT, {
                direction: maxErrorDirection,
                force: force,
                contactPoint: maxErrorBody.transformNode.getAbsolutePosition()
            });
        }
    }

    update(deltaSec) {
        this.processHits();
    }
}