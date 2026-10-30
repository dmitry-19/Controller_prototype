// js/krl.js
// Kinematic Ragdoll Layer + Reaction Pose Library (на основе BoneIKController)

export class KinematicRagdollLayer {
    constructor(scene, boneBodyMap, hierarchy, boneLengths, characterRoot, mesh, skeleton) {
        this.scene = scene;
        this.boneBodyMap = boneBodyMap;
        this.boneLengths = boneLengths || {};
        this.characterRoot = characterRoot;

        // Для IK‑контроллеров нужен доступ к мешу и скелету
        this.mesh = mesh;                 // dynamicMesh
        this.skeleton = skeleton;         // dynamicSkeleton

        this._nodes = new Map();
        this._directTargets = new Map();
        this._lockedBones = new Set();
        this._savedLocals = new Map();

        // IK‑контроллеры для рук (создаются/удаляются по мере активации поз)
        this._ikControllers = { r: null, l: null };
        // Целевые TransformNode для IK‑контроллеров
        this._ikTargetNodes = { r: null, l: null };

        this._lookTarget = null;

        this._buildHierarchy(hierarchy);
        this._syncAllFromPhysics();

        // Заполняем библиотеку поз
        this._initPoseLibrary();
    }

    // ----------------------------------------------------------------
    // Построение иерархии
    // ----------------------------------------------------------------
    _buildHierarchy(hierarchy) {
        for (const item of hierarchy) {
            const node = new BABYLON.TransformNode(`krl_${item.name}`, this.scene);
            this._nodes.set(item.name, node);
        }
        for (const item of hierarchy) {
            if (item.parent) {
                const parentNode = this._nodes.get(item.parent);
                const childNode = this._nodes.get(item.name);
                if (parentNode && childNode) {
                    childNode.parent = parentNode;
                }
            }
        }
    }

    _syncAllFromPhysics() {
        for (const [name, node] of this._nodes.entries()) {
            const body = this.boneBodyMap.get(name);
            if (!body) continue;
            const physNode = body.transformNode;
            const worldPos = physNode.getAbsolutePosition();
            const worldRot = physNode.absoluteRotationQuaternion;

            if (node.parent) {
                const parentMat = node.parent.getWorldMatrix().clone();
                const invParentMat = parentMat.invert();
                const localPos = BABYLON.Vector3.TransformCoordinates(worldPos, invParentMat);
                node.position.copyFrom(localPos);

                if (worldRot) {
                    const parentRot = node.parent.absoluteRotationQuaternion;
                    if (parentRot) {
                        const invParentRot = parentRot.clone().invert();
                        const localRot = invParentRot.multiply(worldRot);
                        node.rotationQuaternion = localRot;
                    } else {
                        node.rotationQuaternion = worldRot.clone();
                    }
                } else {
                    node.rotationQuaternion = null;
                }
            } else {
                node.position.copyFrom(worldPos);
                if (worldRot) node.rotationQuaternion = worldRot.clone();
                else node.rotationQuaternion = null;
            }
        }
    }

    // ----------------------------------------------------------------
    // Библиотека поз (body‑space относительно characterRoot)
    // ----------------------------------------------------------------
    _initPoseLibrary() {
        // Координаты из ik_surface_config.json (правая рука)
        const points = {
            neutral:  { x: -0.265, y: 1.205, z: 0.19372 },
            up:       { x: -0.195, y: 1.61,  z: 0.19 },
            down:     { x: -0.165, y: 0.57,  z: 0.12 },
            toleft:   { x: 0.0,    y: 1.07,  z: 0.205 },
            toright:  { x: -0.355, y: 1.235, z: -0.1 }
        };

        // Параметры BendAxis/PoleAngle возьмём из JSON для правой руки (усредним)
        const defaultRightBend = new BABYLON.Vector3(0, 0, 1);
        const defaultRightPole = 0.0;

        this._poseLibrary = {
            // Блок головы правой рукой (ладонь перед лбом, из точки "up" сдвиг чуть вперёд)
            block_head_r: {
                side: 'r',
                bodyPos: new BABYLON.Vector3(-0.22, 1.55, 0.28),
                bendAxis: defaultRightBend,
                poleAngle: defaultRightPole
            },
            // Блок головы левой рукой (отражение)
            block_head_l: {
                side: 'l',
                bodyPos: new BABYLON.Vector3(0.22, 1.55, 0.28),
                bendAxis: new BABYLON.Vector3(0, 0, -1),
                poleAngle: 0.0
            },
            // Блок торса правой (на основе toleft)
            block_torso_r: {
                side: 'r',
                bodyPos: new BABYLON.Vector3(-0.1, 1.15, 0.30),
                bendAxis: defaultRightBend,
                poleAngle: 0.25
            },
            // Блок торса левой
            block_torso_l: {
                side: 'l',
                bodyPos: new BABYLON.Vector3(0.1, 1.15, 0.30),
                bendAxis: new BABYLON.Vector3(0, 0, -1),
                poleAngle: 0.25
            },
            // Указание вперёд правой рукой
            point_fwd_r: {
                side: 'r',
                bodyPos: new BABYLON.Vector3(-0.25, 1.2, 0.7),
                bendAxis: defaultRightBend,
                poleAngle: 0.0
            },
            // Указание вперёд левой
            point_fwd_l: {
                side: 'l',
                bodyPos: new BABYLON.Vector3(0.25, 1.2, 0.7),
                bendAxis: new BABYLON.Vector3(0, 0, -1),
                poleAngle: 0.0
            },
            // Прикосновение к груди левой рукой (для потирания ушиба)
            touch_chest_l: {
                side: 'l',
                bodyPos: new BABYLON.Vector3(0.12, 1.05, 0.15),
                bendAxis: new BABYLON.Vector3(-1, 0, 0),
                poleAngle: 0.4
            },
            // Прикосновение к голове правой (для «памяти боли»)
            touch_head_r: {
                side: 'r',
                bodyPos: new BABYLON.Vector3(-0.08, 1.5, 0.1),
                bendAxis: defaultRightBend,
                poleAngle: 0.0
            }
        };
    }

    // ----------------------------------------------------------------
    // API поз
    // ----------------------------------------------------------------

    /**
     * Активировать позу для конечности. Создаёт BoneIKController.
     * @param {string} poseName – имя позы из библиотеки
     * @param {number} duration – если >0, поза автоматически деактивируется через duration секунд
     */
    activatePose(poseName, duration = 0) {
        const pose = this._poseLibrary[poseName];
        if (!pose) {
            console.warn(`Pose ${poseName} not found`);
            return;
        }

        const side = pose.side;
        // Сначала снимаем предыдущий IK с этой стороны
        this.deactivatePose(side);

        // Создаём целевую ноду
        const targetNode = new BABYLON.TransformNode(`krl_ik_target_${side}`, this.scene);
        targetNode.parent = this.characterRoot; // чтобы двигалось с персонажем
        targetNode.position.copyFrom(pose.bodyPos);
        this._ikTargetNodes[side] = targetNode;

        // Кость, к которой будем применять IK (обычно lowerarm)
        const lowerarmBone = this.skeleton.bones.find(b => b.name === `lowerarm_${side}`);
        const upperarmBone = this.skeleton.bones.find(b => b.name === `upperarm_${side}`);

        if (!lowerarmBone || !upperarmBone) {
            console.warn(`Bones for side ${side} not found`);
            return;
        }

        try {
            const controller = new BABYLON.BoneIKController(this.mesh, lowerarmBone, {
                targetMesh: targetNode,
                poleTargetBone: upperarmBone,
                poleAngle: pose.poleAngle || 0,
                bendAxis: pose.bendAxis || new BABYLON.Vector3(0, 0, 1),
                slerpAmount: 0.95
            });
            this._ikControllers[side] = controller;

            // Блокируем цепочку руки в KRL
            const chain = [`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`];
            this._lockChain(chain);
        } catch (e) {
            console.error('Failed to create BoneIKController', e);
        }

        if (duration > 0) {
            setTimeout(() => this.deactivatePose(side), duration * 1000);
        }
    }

    /**
     * Деактивировать позу для указанной стороны. Удаляет IK‑контроллер.
     * @param {'r'|'l'} side
     */
    deactivatePose(side = null) {
        if (side) {
            this._removeIK(side);
        } else {
            this._removeIK('r');
            this._removeIK('l');
        }
    }

    _removeIK(side) {
        if (this._ikControllers[side]) {
            try { this._ikControllers[side].dispose(); } catch (e) {}
            this._ikControllers[side] = null;
        }
        if (this._ikTargetNodes[side]) {
            this._ikTargetNodes[side].dispose();
            this._ikTargetNodes[side] = null;
        }
        // Разблокируем цепочку
        const chain = [`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`];
        this._unlockChain(chain);
    }

    // ----------------------------------------------------------------
    // Прямые цели (pelvis, spine, голова)
    // ----------------------------------------------------------------
    setBoneTarget(boneName, worldPos, weight = 1.0) {
        this._directTargets.set(boneName, {
            worldPos: worldPos.clone(),
            weight: BABYLON.Scalar.Clamp(weight, 0, 1),
            space: 'world',
            localPos: null
        });
        this._lockedBones.add(boneName);
    }

    clearBoneTarget(boneName) {
        this._directTargets.delete(boneName);
        this._lockedBones.delete(boneName);
    }

    setLookTarget(worldDirection) {
        if (worldDirection) {
            this._lookTarget = worldDirection.clone().normalize();
            this._lockedBones.add('head');
        } else {
            this._lookTarget = null;
            this._lockedBones.delete('head');
        }
    }

    getTargetPosition(boneName) {
        if (this._lockedBones.has(boneName)) {
            const node = this._nodes.get(boneName);
            return node ? node.getAbsolutePosition() : null;
        }
        return null;
    }

    // ----------------------------------------------------------------
    // Основной цикл
    // ----------------------------------------------------------------
    update(deltaSec) {
        // 1. Синхронизация пассивных костей
        for (const [name, node] of this._nodes.entries()) {
            if (this._lockedBones.has(name)) continue;
            const body = this.boneBodyMap.get(name);
            if (!body) continue;

            const physNode = body.transformNode;
            const worldPos = physNode.getAbsolutePosition();
            const worldRot = physNode.absoluteRotationQuaternion;

            if (node.parent) {
                const parentMat = node.parent.getWorldMatrix().clone();
                const invParentMat = parentMat.invert();
                const localPos = BABYLON.Vector3.TransformCoordinates(worldPos, invParentMat);
                node.position.copyFrom(localPos);
                if (worldRot) {
                    const parentRot = node.parent.absoluteRotationQuaternion;
                    if (parentRot) {
                        const invParentRot = parentRot.clone().invert();
                        const localRot = invParentRot.multiply(worldRot);
                        node.rotationQuaternion = localRot;
                    } else {
                        node.rotationQuaternion = worldRot.clone();
                    }
                } else {
                    node.rotationQuaternion = null;
                }
            } else {
                node.position.copyFrom(worldPos);
                if (worldRot) node.rotationQuaternion = worldRot.clone();
                else node.rotationQuaternion = null;
            }
        }

        // 2. Обновляем IK‑контроллеры
        if (this._ikControllers.r) this._ikControllers.r.update();
        if (this._ikControllers.l) this._ikControllers.l.update();

        // 3. Для активных IK‑сторон обновляем KRL‑позиции рук по текущим позициям костей
        for (const side of ['r', 'l']) {
            if (this._ikControllers[side]) {
                const handBone = this.skeleton.bones.find(b => b.name === `hand_${side}`);
                const lowerarmBone = this.skeleton.bones.find(b => b.name === `lowerarm_${side}`);
                const upperarmBone = this.skeleton.bones.find(b => b.name === `upperarm_${side}`);
                if (handBone && lowerarmBone && upperarmBone) {
                    const handWorld = handBone.getAbsolutePosition(this.mesh);
                    const lowerWorld = lowerarmBone.getAbsolutePosition(this.mesh);
                    const upperWorld = upperarmBone.getAbsolutePosition(this.mesh);

                    // Обновляем KRL‑узлы, чтобы getTargetPosition вернул актуальные позиции
                    this._updateNodeFromWorld(`hand_${side}`, handWorld);
                    this._updateNodeFromWorld(`lowerarm_${side}`, lowerWorld);
                    this._updateNodeFromWorld(`upperarm_${side}`, upperWorld);
                }
            }
        }

        // 4. Прямые цели
        for (const [name, target] of this._directTargets.entries()) {
            const node = this._nodes.get(name);
            if (!node) continue;
            const currentPos = node.getAbsolutePosition();
            const desiredPos = BABYLON.Vector3.Lerp(currentPos, target.worldPos, target.weight);
            if (node.parent) {
                const parentMat = node.parent.getWorldMatrix().clone();
                parentMat.invert();
                const localPos = BABYLON.Vector3.TransformCoordinates(desiredPos, parentMat);
                node.position.copyFrom(localPos);
            } else {
                node.position.copyFrom(desiredPos);
            }
        }

        // 5. Голова
        if (this._lookTarget && this._lockedBones.has('head')) {
            const headNode = this._nodes.get('head');
            if (headNode) {
                const headPos = headNode.getAbsolutePosition();
                const targetPoint = headPos.add(this._lookTarget.scale(1.0));
                const matrix = BABYLON.Matrix.LookAtLH(headPos, targetPoint, BABYLON.Axis.Y);
                const targetRot = BABYLON.Quaternion.FromRotationMatrix(matrix);
                if (headNode.rotationQuaternion) {
                    BABYLON.Quaternion.SlerpToRef(headNode.rotationQuaternion, targetRot, 0.3, headNode.rotationQuaternion);
                } else {
                    headNode.rotationQuaternion = targetRot;
                }
            }
        }
    }

    _updateNodeFromWorld(boneName, worldPos) {
        const node = this._nodes.get(boneName);
        if (!node) return;
        if (node.parent) {
            const parentMat = node.parent.getWorldMatrix().clone();
            const invParentMat = parentMat.invert();
            const localPos = BABYLON.Vector3.TransformCoordinates(worldPos, invParentMat);
            node.position.copyFrom(localPos);
        } else {
            node.position.copyFrom(worldPos);
        }
    }

    // ----------------------------------------------------------------
    // Вспомогательные
    // ----------------------------------------------------------------
    _lockChain(bones) {
        for (const name of bones) {
            const node = this._nodes.get(name);
            if (node) {
                this._savedLocals.set(name, {
                    pos: node.position.clone(),
                    rot: node.rotationQuaternion ? node.rotationQuaternion.clone() : null
                });
                this._lockedBones.add(name);
            }
        }
    }

    _unlockChain(bones) {
        for (const name of bones) {
            this._lockedBones.delete(name);
            this._savedLocals.delete(name);
        }
    }

    dispose() {
        this.deactivatePose();
        for (const node of this._nodes.values()) node.dispose();
        this._nodes.clear();
        this._lockedBones.clear();
        this._savedLocals.clear();
    }
}