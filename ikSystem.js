// js/ikSystem.js
export class LegIK {
    constructor(scene, rootNode, skeleton, mesh, legBones, groundY = 0) {
        this.scene = scene;
        this.rootNode = rootNode;
        this.skeleton = skeleton;
        this.mesh = mesh;
        this.groundY = groundY;
        this.legs = legBones;

        this.footTargets = { left: null, right: null };
        this.controllers = { left: null, right: null };
        this.isActive = false;
        this.activeFoot = null;
        this.stepTargetWorld = new BABYLON.Vector3();

        this.setupIK();
    }

    setupIK() {
        for (let side of ['left', 'right']) {
            const leg = this.legs[side];
            if (!leg.thigh || !leg.calf || !leg.foot) continue;
            const footTarget = new BABYLON.TransformNode(`foot_target_${side}`, this.scene);
            footTarget.parent = this.rootNode;
            this.footTargets[side] = footTarget;
            try {
                const ikController = new BABYLON.BoneIKController(
                    this.mesh,
                    leg.calf,
                    {
                        targetMesh: footTarget,
                        poleTargetBone: leg.thigh,
                        poleAngle: 0,
                        bendAxis: new BABYLON.Vector3(1, 0, 0),
                        slerpAmount: 0.9
                    }
                );
                this.controllers[side] = ikController;
            } catch (e) {
                console.warn(`LegIK: не удалось создать контроллер для ${side}`, e);
            }
        }
    }

    // Проверяет, стоит ли стопа на препятствии (не на земле)
    isFootOnObstacle(footWorldPos, groundY) {
        const rayOrigin = footWorldPos.clone();
        rayOrigin.y += 0.3; // начинаем чуть выше стопы
        const ray = new BABYLON.Ray(rayOrigin, BABYLON.Axis.Y.negate(), 1.0);
        const pick = this.scene.pickWithRay(ray, mesh => {
            if (!mesh.isVisible) return false;
            const tag = mesh.metadata?.tag;
            return tag === "static" || tag === "dynamic" || mesh.name === "ground";
        });

        if (!pick.hit) return false;

        // Если высота поверхности отличается от базового уровня земли больше, чем на порог, считаем препятствием
        const threshold = 0.05;
        return Math.abs(pick.pickedPoint.y - groundY) > threshold;
    }

    // Индивидуальный луч для получения высоты поверхности под стопой
    _getFootGroundPosition(footWorldPos) {
        const rayOrigin = footWorldPos.clone();
        rayOrigin.y += 0.3;
        const ray = new BABYLON.Ray(rayOrigin, BABYLON.Axis.Y.negate(), 1.0);
        const pick = this.scene.pickWithRay(ray, mesh => {
            if (!mesh.isVisible) return false;
            const tag = mesh.metadata?.tag;
            return tag === "static" || tag === "dynamic" || mesh.name === "ground";
        });
        if (pick.hit && pick.pickedPoint) {
            return pick.pickedPoint.y + 0.05;
        }
        return null;
    }

    enableForStep(side, targetWorldPos) {
        this.activeFoot = side;
        this.stepTargetWorld.copyFrom(targetWorldPos);
        this.isActive = true;
    }

    disable() {
        this.isActive = false;
        this.activeFoot = null;
    }

    update(deltaTime, movementSystem) {
        const invRoot = this.rootNode.getWorldMatrix().clone().invert();
        const groundY = movementSystem ? movementSystem.groundY : this.groundY;

        for (let side of ['left', 'right']) {
            const footBone = this.legs[side]?.foot;
            const targetNode = this.footTargets[side];
            if (!footBone || !targetNode) continue;

            const worldPos = footBone.getAbsolutePosition(this.mesh);

            // Проверяем, нужно ли включать IK
            const onObstacle = !this.isActive && this.isFootOnObstacle(worldPos, groundY);

            // Если нет препятствия и нет активного шага – IK полностью выключен для этой ноги
            if (!onObstacle && !this.isActive) {
                continue;
            }

            let desiredWorld = worldPos.clone();
            if (this.isActive && this.activeFoot === side) {
                // Активный шаг – цель задана явно
                desiredWorld.copyFrom(this.stepTargetWorld);
                desiredWorld.y += 0.05;
            } else if (onObstacle) {
                const surfY = this._getFootGroundPosition(worldPos);
                if (surfY !== null) {
                    desiredWorld.y = surfY;
                }
            }

            const desiredLocal = BABYLON.Vector3.TransformCoordinates(desiredWorld, invRoot);
            const speed = this.isActive ? 0.4 : 0.2;
            BABYLON.Vector3.LerpToRef(targetNode.position, desiredLocal, speed, targetNode.position);

            if (this.controllers[side]) this.controllers[side].update();
        }
    }
}

export class SpineIK {
    constructor(scene, skeleton, mesh, spineBone, targetNode, options = {}) {
        this.scene = scene;
        this.skeleton = skeleton;
        this.mesh = mesh;
        this.spineBone = spineBone;
        this.targetNode = targetNode;
        this.weight = options.weight ?? 0.7;
        this.maxAngle = options.maxAngle ?? 45 * Math.PI / 180;
        if (this.spineBone && this.targetNode) {
            this.lookController = new BABYLON.BoneLookController(
                this.mesh, this.spineBone, this.targetNode,
                { weight: this.weight, maxYaw: this.maxAngle, maxPitch: this.maxAngle / 2, maxRoll: 0 }
            );
        } else {
            this.lookController = null;
        }
    }
    update() {
        if (this.lookController && this.targetNode) {
            this.lookController.targetNode = this.targetNode;
            this.lookController.update();
        }
    }
    setWeight(weight) {
        this.weight = weight;
        if (this.lookController) this.lookController.weight = weight;
    }
}