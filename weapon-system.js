// js/weapon-system.js
// Финальная версия: цикл взмаха, настраиваемые параметры, исправленная инверсия, нейтраль 45°, участие плеча.
// Добавлены отладочные сообщения для взмаха.
// 🆕 Ограничение угловой скорости цели, раздельное управление осями.

export class WeaponSystem {
    constructor(scene, skeleton, mesh, upperRoot, config = {}) {
        this.scene = scene;
        this.skeleton = skeleton;
        this.mesh = mesh;
        this.upperRoot = upperRoot;

        // ---------- ПАРАМЕТРЫ МЕЧА ----------
        this.isActive = false;
        this.swordLength = 1.8;
        this.swordMass = config.swordMass ?? 2.5;

        this.mouseControl = {
            leftPressed: false,
            rightPressed: false,
            theta: 0,
            phi: Math.PI / 4          // нейтраль 45° вверх
        };

        // ---------- НАСТРОЙКИ ВЗМАХА ----------
        this.swingDuration = config.swingDuration ?? 0.5;
        this.swingCooldown = config.swingCooldown ?? 0.3;
        this.swingThresholdMin = config.swingThresholdMin ?? 10.0;  // снижен для теста
        this.swingDamping = 5.0;

        this.isSwinging = false;
        this.isReturning = false;
        this.isCooldown = false;
        this.swingTimer = 0;
        this.cooldownTimer = 0;
        this.inputLocked = false;

        this.swingThetaVel = 0;
        this.swingPhiVel = 0;

        this.angleLimits = {
            phi: { min: 0.2, max: Math.PI - 0.2 },
            theta: { min: -Math.PI * 0.7, max: Math.PI * 0.7 }
        };
        this.swingAngleLimits = {
            phi: { min: 0.1, max: Math.PI - 0.1 },
            theta: { min: -Math.PI * 0.85, max: Math.PI * 0.85 }
        };

        this.neutralTheta = 0;
        this.neutralPhi = Math.PI / 4;   // 45°

        // 🆕 Ограничения максимальной скорости поворота цели (рад/с)
        this.maxThetaSpeed = config.maxThetaSpeed ?? 12.0;
        this.maxPhiSpeed   = config.maxPhiSpeed   ?? 12.0;

        this.kinematicTarget = null;
        this.kinematicTargetMesh = null;
        this.targetSphereConfig = {
            radius: 0,
            centerOffset: new BABYLON.Vector3(0, 0, 0)
        };

        this.dynamicSword = null;
        this.dynamicSwordMesh = null;
        this.constraints = [];
        this.hingeToHandR = null;
        this.hingeToHandL = null;
        this.distanceConstraint = null;

        // ---------- ПАРАМЕТРЫ IK РУК (УГЛОВОЕ УПРАВЛЕНИЕ) ----------
        this.handIKController = null;
        this.handTargetNode = null;
        this.handIKControllerL = null;
        this.handTargetNodeL = null;
        this.weaponRoot = null;
        this.handlePoint = null;
        this.baseWeaponRotation = null;

        this.handBoneR = null;
        this.lowerarmBoneR = null;
        this.upperarmBoneR = null;
        this.clavicleBoneR = null;
        this.handBoneL = null;
        this.lowerarmBoneL = null;
        this.upperarmBoneL = null;
        this.clavicleBoneL = null;
        this.spineBone = null;
        this.hipsBone = null;

        this.boneBodyMap = null;

        this.smoothing = {
            handPosition: 0.3,
            swordRotation: 0.5,
            targetMovement: 0.2,
            neutralReturn: 4.0
        };

        this.maxUpperRootYaw = Math.PI / 3;
        this.shoulderLocalPos = new BABYLON.Vector3(0.15, 1.35, 0.20);
        this.maxArmLength = 0.8;
        this.upperarmLength = 0;
        this.forearmLength = 0;

        // ---------- УГЛОВОЕ УПРАВЛЕНИЕ РУКАМИ (ПОЛУСФЕРА) ----------
        this.handAngles = {
            theta: 0,
            phi: Math.PI / 2,
            neutralTheta: 0,
            neutralPhi: Math.PI / 2,
            sensitivity: 0.01,
            returnSpeed: 4.0
        };
        this.handHemisphere = {
            center: new BABYLON.Vector3(0.15, 1.35, 0.20),
            radiusX: 0.45,
            radiusY: 0.55,
            radiusZ: 0.40
        };
        this.ikPoints = [];

        this.desiredMarkerLocalPos = new BABYLON.Vector3();
        this.currentMarkerLocalPos = new BABYLON.Vector3();

        this.ikParams = {
            gripOffset: new BABYLON.Vector3(0, 0, 0),
            leftPoleAngle: 0,
            rightPoleAngle: 0,
            leftBendAxis: new BABYLON.Vector3(0, 0, 1),
            rightBendAxis: new BABYLON.Vector3(0, 0, 1)
        };

        this.modes = {
            idle: new IdleMode(this),
            attack: new AttackMode(this),
            block: new BlockMode(this)
        };
        this.currentMode = this.modes.idle;
        this.activeMode = 'idle';

        // Инициализация
        this.findBones();
        if (this.handBoneR) {
            this.computeMaxArmLength();
            this.createWeaponMesh();
            this.setupHandIK();
            this.setupHandIK_L();
        }

        this.initIKPoints();
        this.recreateIKControllers();

        this.targetSphereConfig.radius = this.maxArmLength + this.swordLength * 0.7;
        this.createTargetMesh();
        console.log('⚔️ WeaponSystem готов (взмах, кулдаун, 45°, плечо, 🆕ограничение скорости)');
    }

    // ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------
    computeMaxArmLength() {
        if (!this.upperarmBoneR || !this.lowerarmBoneR || !this.handBoneR) return;
        const upperPos = this.upperarmBoneR.getAbsolutePosition(this.mesh);
        const lowerPos = this.lowerarmBoneR.getAbsolutePosition(this.mesh);
        const handPos = this.handBoneR.getAbsolutePosition(this.mesh);
        this.upperarmLength = BABYLON.Vector3.Distance(upperPos, lowerPos);
        this.forearmLength = BABYLON.Vector3.Distance(lowerPos, handPos);
        this.maxArmLength = this.upperarmLength + this.forearmLength;
        this.shoulderLocalPos = BABYLON.Vector3.TransformCoordinates(upperPos, this.upperRoot.getWorldMatrix().clone().invert());
        this.handHemisphere.center = this.shoulderLocalPos.clone();
        this.targetSphereConfig.centerOffset = this.shoulderLocalPos.clone();
    }

    initIKPoints() {
        const keyframes = [
            { theta: 0, phi: Math.PI/2, name: 'neutral', grip: {x:-0.08,y:0.14,z:0.10}, leftPole:0, rightPole:0 },
            { theta: -0.8, phi: Math.PI/2, name: 'left', grip: {x:0.22,y:0.01,z:0.02}, leftPole:0.5, rightPole:0.3 },
            { theta: 0.8, phi: Math.PI/2, name: 'right', grip: {x:0.18,y:0.07,z:-0.05}, leftPole:0.0, rightPole:0.0 },
            { theta: 0, phi: 0.3, name: 'up', grip: {x:0.10,y:0.05,z:-0.12}, leftPole:1.8, rightPole:5.0 },
            { theta: 0, phi: 2.8, name: 'down', grip: {x:-0.03,y:-0.13,z:0.20}, leftPole:3.0, rightPole:0.0 },
            { theta: -0.5, phi: 0.8, name: 'up_left', grip: {x:0.16,y:0.05,z:-0.05}, leftPole:1.0, rightPole:2.0 },
            { theta: 0.5, phi: 0.8, name: 'up_right', grip: {x:0.12,y:0.07,z:-0.08}, leftPole:0.8, rightPole:4.0 }
        ];

        this.ikPoints = keyframes.map((kf, idx) => {
            const pos = this.anglesToLocalPosition(kf.theta, kf.phi);
            return {
                id: `kp_${idx}`,
                name: kf.name,
                rightHand: { x: pos.x, y: pos.y, z: pos.z },
                gripOffset: { x: kf.grip.x, y: kf.grip.y, z: kf.grip.z },
                leftBendAxis: '0,0,1',
                rightBendAxis: '0,0,1',
                leftPoleAngle: kf.leftPole,
                rightPoleAngle: kf.rightPole
            };
        });

        const neutral = this.ikPoints.find(p => p.name === 'neutral') || this.ikPoints[0];
        this.desiredMarkerLocalPos.set(neutral.rightHand.x, neutral.rightHand.y, neutral.rightHand.z);
        this.currentMarkerLocalPos.copyFrom(this.desiredMarkerLocalPos);
    }

    anglesToLocalPosition(theta, phi) {
        const c = this.handHemisphere.center;
        const rx = this.handHemisphere.radiusX;
        const ry = this.handHemisphere.radiusY;
        const rz = this.handHemisphere.radiusZ;
        phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
        return new BABYLON.Vector3(
            c.x + rx * Math.sin(phi) * Math.sin(theta),
            c.y + ry * Math.cos(phi),
            c.z + rz * Math.sin(phi) * Math.cos(theta)
        );
    }

    // ---------- ОБНОВЛЕНИЕ СОСТОЯНИЯ ВЗМАХА ----------
    updateSwingState(deltaTime) {
        if (this.isSwinging) {
            this.swingTimer -= deltaTime;
            if (this.swingTimer <= 0) {
                this.isSwinging = false;
                this.isReturning = true;
                this.inputLocked = true;
                console.log('Swing finished, returning to neutral');
            }
        } else if (this.isReturning) {
            const angleDiff = Math.abs(this.mouseControl.theta - this.neutralTheta) +
                              Math.abs(this.mouseControl.phi - this.neutralPhi);
            if (angleDiff < 0.05) {
                this.isReturning = false;
                this.isCooldown = true;
                this.cooldownTimer = this.swingCooldown;
                this.inputLocked = true;
                console.log('Returned to neutral, cooldown started');
            }
        } else if (this.isCooldown) {
            this.cooldownTimer -= deltaTime;
            if (this.cooldownTimer <= 0) {
                this.isCooldown = false;
                this.inputLocked = false;
                console.log('Cooldown finished, input enabled');
            }
        }
    }

    // ---------- ОБНОВЛЕНИЕ УГЛОВ РУК (СИНХРОНИЗИРОВАНО С МЕЧОМ) ----------
    updateHandAnglesFromMouse(deltaTime, mouseDeltaX, mouseDeltaY, leftPressed, rightPressed) {
        const sens = this.handAngles.sensitivity;
        if (leftPressed && !rightPressed) {
            this.handAngles.theta += mouseDeltaX * sens;
        } else if (rightPressed && !leftPressed) {
            this.handAngles.phi += mouseDeltaY * sens;
        } else if (leftPressed && rightPressed) {
            this.handAngles.theta += mouseDeltaX * sens;
            this.handAngles.phi += mouseDeltaY * sens;
        } else {
            this.handAngles.theta = BABYLON.Scalar.Lerp(this.handAngles.theta, this.handAngles.neutralTheta, this.handAngles.returnSpeed * deltaTime);
            this.handAngles.phi = BABYLON.Scalar.Lerp(this.handAngles.phi, this.handAngles.neutralPhi, this.handAngles.returnSpeed * deltaTime);
        }

        this.handAngles.theta = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.handAngles.theta));
        this.handAngles.phi = Math.max(0.2, Math.min(Math.PI - 0.2, this.handAngles.phi));

        this.desiredMarkerLocalPos = this.anglesToLocalPosition(this.handAngles.theta, this.handAngles.phi);
    }

    updateIKFromMarker(localPoint) {
        if (!this.ikPoints.length) return;

        const distances = this.ikPoints.map(p => {
            const dx = localPoint.x - p.rightHand.x;
            const dy = localPoint.y - p.rightHand.y;
            const dz = localPoint.z - p.rightHand.z;
            return Math.sqrt(dx*dx + dy*dy + dz*dz);
        });

        let nearestIdx = 0;
        distances.forEach((d, i) => { if (d < distances[nearestIdx]) nearestIdx = i; });

        const threshold = 0.1;
        let weights;
        if (distances[nearestIdx] < threshold) {
            weights = this.ikPoints.map((_, i) => i === nearestIdx ? 1 : 0);
        } else {
            const eps = 0.001;
            const raw = distances.map(d => 1.0 / (Math.pow(d, 4) + eps));
            const sum = raw.reduce((a,b) => a+b, 0);
            weights = raw.map(w => w / sum);
        }

        let gripX=0, gripY=0, gripZ=0, lp=0, rp=0;
        for (let i=0; i<this.ikPoints.length; i++) {
            const w = weights[i];
            const p = this.ikPoints[i];
            gripX += w * p.gripOffset.x;
            gripY += w * p.gripOffset.y;
            gripZ += w * p.gripOffset.z;
            lp += w * p.leftPoleAngle;
            rp += w * p.rightPoleAngle;
        }
        this.ikParams.gripOffset.set(gripX, gripY, gripZ);
        this.ikParams.leftPoleAngle = lp;
        this.ikParams.rightPoleAngle = rp;

        if (Math.abs(this.ikParams.leftPoleAngle - lp) > 0.01 || Math.abs(this.ikParams.rightPoleAngle - rp) > 0.01) {
            this.recreateIKControllers();
        }
    }

    recreateIKControllers() {
        if (this.handIKController) { try { this.handIKController.dispose(); } catch(e) {} this.handIKController = null; }
        if (this.handIKControllerL) { try { this.handIKControllerL.dispose(); } catch(e) {} this.handIKControllerL = null; }

        const poleRight = this.clavicleBoneR || this.upperarmBoneR?.parent || this.upperarmBoneR;
        const poleLeft = this.clavicleBoneL || this.upperarmBoneL?.parent || this.upperarmBoneL;

        if (this.lowerarmBoneR && this.handTargetNode) {
            this.handIKController = new BABYLON.BoneIKController(this.mesh, this.lowerarmBoneR, {
                targetMesh: this.handTargetNode,
                poleTargetBone: poleRight,
                poleAngle: this.ikParams.rightPoleAngle,
                bendAxis: this.ikParams.rightBendAxis,
                slerpAmount: 0.95
            });
        }
        if (this.lowerarmBoneL && this.handTargetNodeL) {
            this.handIKControllerL = new BABYLON.BoneIKController(this.mesh, this.lowerarmBoneL, {
                targetMesh: this.handTargetNodeL,
                poleTargetBone: poleLeft,
                poleAngle: this.ikParams.leftPoleAngle,
                bendAxis: this.ikParams.leftBendAxis,
                slerpAmount: 0.95
            });
        }
    }

    updateHandTargets(deltaTime) {
        const speed = 5.0;
        BABYLON.Vector3.SmoothToRef(this.currentMarkerLocalPos, this.desiredMarkerLocalPos, speed, deltaTime, this.currentMarkerLocalPos);
        this.handTargetNode.position.copyFrom(this.currentMarkerLocalPos);
        this.handTargetNodeL.position.copyFrom(this.currentMarkerLocalPos).addInPlace(this.ikParams.gripOffset);
        if (this.handIKController) this.handIKController.update();
        if (this.handIKControllerL) this.handIKControllerL.update();
    }

    // ---------- ПОВОРОТ КОРПУСА ----------
    updateUpperRootLimited(deltaTime, worldTarget) {
        if (!this.hipsBone) return;
        const localTarget = BABYLON.Vector3.TransformCoordinates(worldTarget, this.upperRoot.getWorldMatrix().clone().invert());
        let targetYaw = Math.atan2(localTarget.x, localTarget.z);
        const hipsMatrix = this.hipsBone.getWorldMatrix();
        const hipsYaw = Math.atan2(hipsMatrix.m[8], hipsMatrix.m[10]);
        let relativeYaw = targetYaw - hipsYaw;
        while (relativeYaw > Math.PI) relativeYaw -= 2*Math.PI;
        while (relativeYaw < -Math.PI) relativeYaw += 2*Math.PI;
        relativeYaw = Math.max(-this.maxUpperRootYaw, Math.min(this.maxUpperRootYaw, relativeYaw));
        targetYaw = hipsYaw + relativeYaw;
        let diff = targetYaw - this.upperRoot.rotation.y;
        while (diff > Math.PI) diff -= 2*Math.PI;
        while (diff < -Math.PI) diff += 2*Math.PI;
        this.upperRoot.rotation.y += diff * 10.0 * deltaTime;
    }

    // ---------- МЕТОДЫ МЕЧА (С УЧЁТОМ ВЗМАХА И ОГРАНИЧЕНИЯ СКОРОСТИ) ----------
    createTargetMesh() {
        this.kinematicTargetMesh = BABYLON.MeshBuilder.CreateSphere("kinematicTargetSphere", { diameter: 0.4 }, this.scene);
        this.kinematicTargetMesh.isVisible = false;
        this.kinematicTargetMesh.parent = this.upperRoot;
        this.updateTargetPosition();
    }

    updateTargetAngles(deltaTime, mouseDeltaX, mouseDeltaY, leftPressed, rightPressed) {
        // Если ввод заблокирован, обрабатываем только инерцию взмаха
        if (this.inputLocked) {
            if (this.isSwinging) {
                this.swingThetaVel *= (1 - this.swingDamping * deltaTime);
                this.swingPhiVel *= (1 - this.swingDamping * deltaTime);
                this.mouseControl.theta += this.swingThetaVel * deltaTime;
                this.mouseControl.phi += this.swingPhiVel * deltaTime;
            }
            return;
        }

        const sensitivity = 0.008;
        let deltaTheta = (mouseDeltaX || 0) * sensitivity;
        let deltaPhi = (mouseDeltaY || 0) * sensitivity;

        // --- 🆕 ОГРАНИЧЕНИЕ МАКСИМАЛЬНОЙ УГЛОВОЙ СКОРОСТИ ---
        const maxDTheta = this.maxThetaSpeed * deltaTime;
        const maxDPhi   = this.maxPhiSpeed   * deltaTime;
        deltaTheta = Math.max(-maxDTheta, Math.min(maxDTheta, deltaTheta));
        deltaPhi   = Math.max(-maxDPhi,   Math.min(maxDPhi,   deltaPhi));

        const inputActive = (this.activeMode === 'attack' && (leftPressed || rightPressed));

        if (!this.isSwinging && inputActive) {
            let angularSpeed = Math.hypot(deltaTheta, deltaPhi) / deltaTime;
            if (angularSpeed >= this.swingThresholdMin) {
                // Взмах
                this.isSwinging = true;
                this.swingTimer = this.swingDuration;
                this.inputLocked = true;
                this.swingThetaVel = deltaTheta / deltaTime;
                this.swingPhiVel   = deltaPhi   / deltaTime;
                const maxVel = 25.0;
                this.swingThetaVel = Math.min(maxVel, Math.max(-maxVel, this.swingThetaVel));
                this.swingPhiVel   = Math.min(maxVel, Math.max(-maxVel, this.swingPhiVel));
                this.mouseControl.theta += this.swingThetaVel * deltaTime;
                this.mouseControl.phi   += this.swingPhiVel   * deltaTime;
            } else {
                // Обычное управление с разделением осей (ЛКМ → theta, ПКМ → phi)
                if (leftPressed && !rightPressed) {
                    this.mouseControl.theta += deltaTheta;
                } else if (rightPressed && !leftPressed) {
                    this.mouseControl.phi += deltaPhi;
                } else if (leftPressed && rightPressed) {
                    this.mouseControl.theta += deltaTheta;
                    this.mouseControl.phi   += deltaPhi;
                }
            }
        } else if (this.isSwinging) {
            this.swingThetaVel *= (1 - this.swingDamping * deltaTime);
            this.swingPhiVel   *= (1 - this.swingDamping * deltaTime);
            this.mouseControl.theta += this.swingThetaVel * deltaTime;
            this.mouseControl.phi   += this.swingPhiVel   * deltaTime;
        }

        const limits = this.isSwinging ? this.swingAngleLimits : this.angleLimits;
        const twoPi = Math.PI * 2;
        this.mouseControl.theta = ((this.mouseControl.theta % twoPi) + twoPi) % twoPi;
        if (this.mouseControl.theta > Math.PI) this.mouseControl.theta -= twoPi;
        this.mouseControl.phi = Math.max(limits.phi.min, Math.min(limits.phi.max, this.mouseControl.phi));
        this.mouseControl.theta = Math.max(limits.theta.min, Math.min(limits.theta.max, this.mouseControl.theta));
    }

    updateNeutralReturn(deltaTime) {
        if (this.isReturning || (!this.isSwinging && !this.inputLocked && !this.mouseControl.leftPressed && !this.mouseControl.rightPressed)) {
            let changed = false;
            if (Math.abs(this.mouseControl.theta - this.neutralTheta) > 0.01) {
                this.mouseControl.theta = BABYLON.Scalar.Lerp(this.mouseControl.theta, this.neutralTheta, this.smoothing.neutralReturn * deltaTime);
                changed = true;
            }
            if (Math.abs(this.mouseControl.phi - this.neutralPhi) > 0.01) {
                this.mouseControl.phi = BABYLON.Scalar.Lerp(this.mouseControl.phi, this.neutralPhi, this.smoothing.neutralReturn * deltaTime);
                changed = true;
            }
            if (changed) this.updateTargetPosition();
        }
    }

    updateTargetPosition() {
        if (!this.kinematicTargetMesh) return;
        const center = this.targetSphereConfig.centerOffset;
        const r = this.targetSphereConfig.radius;
        const theta = this.mouseControl.theta;
        const phi = this.mouseControl.phi;
        const targetLocal = new BABYLON.Vector3(
            center.x + r * Math.sin(phi) * Math.sin(theta),
            center.y + r * Math.cos(phi),
            center.z + r * Math.sin(phi) * Math.cos(theta)
        );
        const smooth = this.isSwinging ? 1.0 : this.smoothing.targetMovement;
        const newLocal = BABYLON.Vector3.Lerp(this.kinematicTargetMesh.position, targetLocal, smooth);
        this.kinematicTargetMesh.position = newLocal;
        const worldPos = this.kinematicTargetMesh.getAbsolutePosition();
        if (this.kinematicTarget?.body?.setKinematicTarget) {
            this.kinematicTarget.body.setKinematicTarget(worldPos);
        }
    }

    createKinematicTargetBody() {
        if (this.kinematicTarget || !this.scene.getPhysicsEngine() || !this.kinematicTargetMesh) return;
        this.kinematicTarget = new BABYLON.PhysicsAggregate(this.kinematicTargetMesh, BABYLON.PhysicsShapeType.SPHERE, { mass: 0 }, this.scene);
        this.kinematicTarget.body.setCollisionCallbackEnabled(false);
    }

    createDynamicSword() {
        if (this.dynamicSwordMesh || !this.scene.getPhysicsEngine()) return;
        this.dynamicSwordMesh = BABYLON.MeshBuilder.CreateCylinder("dynamicSword", { height: this.swordLength, diameterTop: 0.04, diameterBottom: 0.08 }, this.scene);
        const mat = new BABYLON.StandardMaterial("swordMat", this.scene);
        mat.diffuseColor = new BABYLON.Color3(0.85, 0.9, 0.95);
        mat.emissiveColor = new BABYLON.Color3(0.3, 0.35, 0.4);
        this.dynamicSwordMesh.material = mat;
        this.dynamicSwordMesh.position.copyFrom(this.kinematicTargetMesh.getAbsolutePosition());
        this.dynamicSwordMesh.rotation.x = Math.PI / 2;
        this.dynamicSword = new BABYLON.PhysicsAggregate(this.dynamicSwordMesh, BABYLON.PhysicsShapeType.CYLINDER, { mass: this.swordMass, restitution: 0.1, friction: 0.5 }, this.scene);
        this.dynamicSword.body.setCollisionCallbackEnabled(true);
        this.dynamicSword.body.setLinearDamping(0.3);
        this.dynamicSword.body.setAngularDamping(0.5);
        this.dynamicSword.body.getCollisionObservable().add(() => {
            this._collisionStiffnessBoost = 2.5;
            this._collisionBoostTimer = 0.3;
        });
    }

    createConstraints() {
        this.destroyDynamicConstraints();
        if (!this.scene.getPhysicsEngine() || !this.dynamicSword) return;
        if (this.boneBodyMap) {
            const handBodyR = this.boneBodyMap.get(this.handBoneR?.name);
            if (handBodyR) {
                const handWorld = this.handBoneR.getAbsolutePosition(this.mesh);
                const bodyWorld = handBodyR.transformNode.getAbsolutePosition();
                const pivotHand = handWorld.subtract(bodyWorld);
                const pivotSword = new BABYLON.Vector3(0, -this.swordLength/2+0.1, 0);
                const limits = [
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_X, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Y, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Z, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_X, minLimit:-Math.PI/6, maxLimit:Math.PI/6 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Y, minLimit:-Math.PI/6, maxLimit:Math.PI/2 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Z, minLimit:-Math.PI/6, maxLimit:Math.PI/6 }
                ];
                const c = new BABYLON.Physics6DoFConstraint({ pivotA: pivotHand, pivotB: pivotSword }, limits, this.scene);
                handBodyR.addConstraint(this.dynamicSword.body, c);
                this.constraints.push(c);
                this.hingeToHandR = c;
            }
            const handBodyL = this.boneBodyMap.get(this.handBoneL?.name);
            if (handBodyL) {
                const handWorld = this.handBoneL.getAbsolutePosition(this.mesh);
                const bodyWorld = handBodyL.transformNode.getAbsolutePosition();
                const pivotHand = handWorld.subtract(bodyWorld);
                const pivotSword = new BABYLON.Vector3(0, -this.swordLength/2+0.1, 0);
                const limits = [
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_X, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Y, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.LINEAR_Z, minLimit:0, maxLimit:0 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_X, minLimit:-Math.PI/12, maxLimit:Math.PI/12 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Y, minLimit:-Math.PI/12, maxLimit:Math.PI/12 },
                    { axis: BABYLON.PhysicsConstraintAxis.ANGULAR_Z, minLimit:-Math.PI/12, maxLimit:Math.PI/12 }
                ];
                const c = new BABYLON.Physics6DoFConstraint({ pivotA: pivotHand, pivotB: pivotSword }, limits, this.scene);
                handBodyL.addConstraint(this.dynamicSword.body, c);
                this.constraints.push(c);
                this.hingeToHandL = c;
            }
            if (handBodyR && handBodyL) {
                const posR = handBodyR.transformNode.getAbsolutePosition();
                const posL = handBodyL.transformNode.getAbsolutePosition();
                const rest = BABYLON.Vector3.Distance(posR, posL);
                const c = new BABYLON.Physics6DoFConstraint(
                    { pivotA: BABYLON.Vector3.Zero(), pivotB: BABYLON.Vector3.Zero() },
                    [{ axis: BABYLON.PhysicsConstraintAxis.LINEAR_DISTANCE, minLimit: rest*0.8, maxLimit: rest*1.2, stiffness:200, damping:20 }],
                    this.scene
                );
                handBodyR.addConstraint(handBodyL, c);
                this.constraints.push(c);
                this.distanceConstraint = c;
            }
        }
    }

    destroyDynamicConstraints() {
        this.constraints.forEach(c => { try { c.dispose(); } catch(e) {} });
        this.constraints = [];
    }

    destroyDynamicSword() {
        this.destroyDynamicConstraints();
        if (this.dynamicSword) { try { this.dynamicSword.dispose(); } catch(e) {} this.dynamicSword = null; }
        if (this.dynamicSwordMesh) { this.dynamicSwordMesh.dispose(); this.dynamicSwordMesh = null; }
    }

    applySpringForce(deltaTime) {
        if (!this.dynamicSword?.body || !this.kinematicTargetMesh) return;
        const targetPos = this.kinematicTargetMesh.getAbsolutePosition();
        const swordPos = this.dynamicSwordMesh.getAbsolutePosition();
        const error = targetPos.subtract(swordPos);
        let stiffness = 200;
        let damping = 25;
        if (this._collisionBoostTimer > 0) {
            stiffness *= this._collisionStiffnessBoost || 2.0;
            damping *= 1.6;
            this._collisionBoostTimer -= deltaTime;
        }
        const vel = this.dynamicSword.body.getLinearVelocity() || BABYLON.Vector3.Zero();
        const force = error.scale(stiffness).subtract(vel.scale(damping));
        this.dynamicSword.body.applyForce(force, swordPos);
        const tipOffset = new BABYLON.Vector3(0, this.swordLength/2, 0);
        const tipWorld = swordPos.add(tipOffset);
        const tipError = targetPos.subtract(tipWorld);
        const torque = tipError.cross(new BABYLON.Vector3(0, 1, 0)).scale(30);
        this.dynamicSword.body.applyTorque(torque);
    }

    // ---------- ОСТАЛЬНЫЕ МЕТОДЫ ----------
    setActive(active) {
        this.isActive = active;
        if (this.weaponRoot) this.weaponRoot.setEnabled(!active);
        if (active) {
            this.mouseControl.theta = this.neutralTheta;
            this.mouseControl.phi = this.neutralPhi;
            this.updateTargetPosition();
            this.setActiveMode('attack');
            this.createKinematicTargetBody();
            this.createDynamicSword();
            this.createConstraints();
            this.isSwinging = false;
            this.isReturning = false;
            this.isCooldown = false;
            this.inputLocked = false;
        } else {
            this.setActiveMode('idle');
            this.disableConstraints();
            this.destroyDynamicSword();
        }
    }
    setActiveMode(modeName) { if (this.modes[modeName]) { this.currentMode = this.modes[modeName]; this.activeMode = modeName; } }
    setBoneBodyMap(map) { this.boneBodyMap = map; }
    update(deltaTime, mouseDeltaX, mouseDeltaY, mouseX, mouseY, leftPressed, rightPressed) {
        if (this.isActive) {
            this.mouseControl.leftPressed = leftPressed;
            this.mouseControl.rightPressed = rightPressed;
            this.updateSwingState(deltaTime);
            this.currentMode.update(deltaTime, mouseDeltaX, mouseDeltaY, mouseX, mouseY, leftPressed, rightPressed);
        }
    }
    findBones() {
        const find = p => this.skeleton.bones.find(b => b.name.toLowerCase().includes(p.toLowerCase()));
        this.handBoneR = find('hand_r');
        this.lowerarmBoneR = find('lowerarm_r');
        this.upperarmBoneR = find('upperarm_r');
        this.clavicleBoneR = find('clavicle_r');
        this.handBoneL = find('hand_l');
        this.lowerarmBoneL = find('lowerarm_l');
        this.upperarmBoneL = find('upperarm_l');
        this.clavicleBoneL = find('clavicle_l');
        this.spineBone = find('spine_03') || find('spine03');
        this.hipsBone = find('hips') || find('pelvis');
    }
    setupHandIK() {
        if (!this.handBoneR || !this.lowerarmBoneR) return;
        this.handTargetNode = new BABYLON.TransformNode('hand_ik_target', this.scene);
        this.handTargetNode.parent = this.upperRoot;
    }
    setupHandIK_L() {
        if (!this.handBoneL || !this.lowerarmBoneL) return;
        this.handTargetNodeL = new BABYLON.TransformNode('hand_ik_target_L', this.scene);
        this.handTargetNodeL.parent = this.upperRoot;
    }
    createWeaponMesh() {
        if (!this.handBoneR) return;
        this.weaponRoot = new BABYLON.TransformNode('weapon_root', this.scene);
        this.weaponRoot.attachToBone(this.handBoneR, this.mesh);
        this.weaponRoot.position = new BABYLON.Vector3(0.08, -0.05, 0.12);
        this.baseWeaponRotation = BABYLON.Quaternion.FromEulerAngles(0, 0, Math.PI / 2);
        this.handlePoint = new BABYLON.TransformNode('handle_point', this.scene);
        this.handlePoint.parent = this.weaponRoot;
        this.handlePoint.position = new BABYLON.Vector3(0, -0.12, 0);
        const blade = BABYLON.MeshBuilder.CreateCylinder('blade', { height: this.swordLength, diameterTop: 0.04, diameterBottom: 0.08 }, this.scene);
        const mat = new BABYLON.StandardMaterial('bladeMat', this.scene);
        mat.diffuseColor = new BABYLON.Color3(0.85, 0.85, 0.9);
        blade.material = mat;
        blade.parent = this.weaponRoot;
        blade.position.y = this.swordLength / 2;
    }
    disableConstraints() { this.destroyDynamicConstraints(); }
    dispose() {
        this.destroyDynamicSword();
        if (this.kinematicTarget) try { this.kinematicTarget.dispose(); } catch(e) {}
        if (this.kinematicTargetMesh) this.kinematicTargetMesh.dispose();
        if (this.weaponRoot) this.weaponRoot.dispose();
        if (this.handTargetNode) this.handTargetNode.dispose();
        if (this.handTargetNodeL) this.handTargetNodeL.dispose();
    }
}

// ========== РЕЖИМЫ ==========
class WeaponModeBase { constructor(weapon) { this.weapon = weapon; } update() {} }
class IdleMode extends WeaponModeBase { update(dt) { this.weapon.updateNeutralReturn(dt); } }
class AttackMode extends WeaponModeBase {
    update(deltaTime, mouseDeltaX, mouseDeltaY, mouseX, mouseY, leftPressed, rightPressed) {
        const w = this.weapon;
        if (!w.isActive) return;

        w.updateHandAnglesFromMouse(deltaTime, mouseDeltaX, mouseDeltaY, leftPressed, rightPressed);
        w.updateIKFromMarker(w.desiredMarkerLocalPos);
        w.updateHandTargets(deltaTime);

        const worldMarker = w.upperRoot.getAbsolutePosition().add(w.currentMarkerLocalPos);
        w.updateUpperRootLimited(deltaTime, worldMarker);

        w.updateTargetAngles(deltaTime, mouseDeltaX, mouseDeltaY, leftPressed, rightPressed);
        w.updateNeutralReturn(deltaTime);
        w.updateTargetPosition();
        w.applySpringForce(deltaTime);
    }
}
class BlockMode extends WeaponModeBase { /* заглушка */ }