// js/dynamicInteraction.js
import { STATE_NAMES } from './stateMachine.js';

export class DynamicInteractionManager {
    constructor(scene, camera, upperRoot, meshUpper, skeleton, boneBodyMap,
                animManager, staminaSystem, movementSystem, weaponSystem, reactionSystem, stateMachine) {
        this.scene = scene;
        this.camera = camera;
        this.upperRoot = upperRoot;
        this.mesh = meshUpper;
        this.skeleton = skeleton;
        this.boneBodyMap = boneBodyMap;
        this.animManager = animManager;
        this.stamina = staminaSystem;
        this.movement = movementSystem;
        this.weaponSystem = weaponSystem;
        this.reactionSystem = reactionSystem;
        this.stateMachine = stateMachine;

        this.state = 'idle';
        this.targetObject = null;
        this.grabDistance = 2.0;
        this.cooldownTimer = 0;
        this.defendCooldown = 0.5;
        this.isRightMouseHeld = false;

        this.isGrabbing = false;
        this.grabMode = null;
        this.grabTargetBody = null;
        this.grabIKTargetR = null;
        this.grabIKTargetL = null;
        this.ikControllerR = null;
        this.ikControllerL = null;
        this.grabPointLocalR = null;
        this.grabPointLocalL = null;
        this.grabOffsetLocalR = null;
        this.grabOffsetLocalL = null;
        this.springActive = false;
        this.savedCollisionMask = null;
        this.savedMeshTag = null;

        this.springStiffness = 200.0;
        this.springDamping = 25.0;
        this.maxGrabSpeed = 5.0;

        this.ikSpeedBase = 8.0;
        this.handSensitivityBase = 0.05;
        this.handAngles = { theta: 0, phi: Math.PI / 2 };
        this.neutralTheta = 0;
        this.neutralPhi = Math.PI / 2;

        this.downForceStrength = 50.0;
        this.lightSizeMax = 0.6;
        this.heavySizeMin = 1.5;
        this.heavyMassMin = 10.0;

        this.savedMaxWalk = 2.2;
        this.savedMaxRun = 5.6;

        this.isHeavyGrabbing = false;

        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.mouseDelta = new BABYLON.Vector2(0, 0);

        this.handBoneR = this._findBone('hand_r');
        this.lowerarmBoneR = this._findBone('lowerarm_r') || this._findBone('forearm_r');
        this.upperarmBoneR = this._findBone('upperarm_r');
        this.handBoneL = this._findBone('hand_l');
        this.lowerarmBoneL = this._findBone('lowerarm_l') || this._findBone('forearm_l');
        this.upperarmBoneL = this._findBone('upperarm_l');
        this.hipsBone = this._findBone('hips') || this._findBone('pelvis');

        this._defendActive = false;
        this._throwAnimName = null;
        this._sideBlockTimer = 0;

        console.log('[DIM] Initialized');
    }

    _findBone(namePart) {
        return this.skeleton.bones.find(b => b.name.toLowerCase().includes(namePart.toLowerCase()));
    }

    _isRagdollActive() {
        if (!this.stateMachine || !this.stateMachine.currentState) return false;
        const name = this.stateMachine.currentState.name;
        return name === STATE_NAMES.RAGDOLL || name === STATE_NAMES.KNOCKDOWN || name === STATE_NAMES.GET_UP;
    }

    _distanceToAABBWorld(point, mesh) {
        if (!mesh.getBoundingInfo) return Infinity;
        const aabb = mesh.getBoundingInfo().boundingBox;
        const centerWorld = aabb.centerWorld;
        const extentsWorld = aabb.extendSize;
        const closest = new BABYLON.Vector3(
            Math.max(centerWorld.x - extentsWorld.x, Math.min(point.x, centerWorld.x + extentsWorld.x)),
            Math.max(centerWorld.y - extentsWorld.y, Math.min(point.y, centerWorld.y + extentsWorld.y)),
            Math.max(centerWorld.z - extentsWorld.z, Math.min(point.z, centerWorld.z + extentsWorld.z))
        );
        return BABYLON.Vector3.Distance(point, closest);
    }

    _getClosestDynamicObject() {
        const origin = this.upperRoot.getAbsolutePosition();
        let bestDist = Infinity;
        let bestMesh = null;
        for (const mesh of this.scene.meshes) {
            if (!mesh.isVisible || mesh.metadata?.tag !== 'dynamic') continue;
            if (!mesh.getBoundingInfo) continue;
            const dist = this._distanceToAABBWorld(origin, mesh);
            if (dist < this.grabDistance && dist < bestDist) {
                bestDist = dist;
                bestMesh = mesh;
            }
        }
        if (bestMesh) {
            const dir = bestMesh.getAbsolutePosition().subtract(origin).normalize();
            const ray = new BABYLON.Ray(origin, dir, this.grabDistance + 1);
            const pick = this.scene.pickWithRay(ray, mesh => mesh === bestMesh);
            const point = pick?.pickedPoint || bestMesh.getAbsolutePosition();
            const halfSize = bestMesh.getBoundingInfo().boundingBox.extendSize;
            const realSize = new BABYLON.Vector3(halfSize.x * 2, halfSize.y * 2, halfSize.z * 2);
            return {
                mesh: bestMesh,
                point,
                normal: (pick ? pick.getNormal(true) : new BABYLON.Vector3(0,1,0)),
                size: realSize,
                halfSize: halfSize,
                mass: bestMesh.physicsBody?.mass || 1
            };
        }
        return null;
    }

    _getAllNearby() {
        const origin = this.upperRoot.getAbsolutePosition();
        const result = [];
        for (const mesh of this.scene.meshes) {
            if (!mesh.isVisible || mesh.metadata?.tag !== 'dynamic') continue;
            if (!mesh.getBoundingInfo) continue;
            const dist = this._distanceToAABBWorld(origin, mesh);
            if (dist < this.grabDistance) {
                const halfSize = mesh.getBoundingInfo().boundingBox.extendSize;
                result.push({
                    mesh,
                    dist,
                    center: mesh.getBoundingInfo().boundingBox.centerWorld,
                    size: new BABYLON.Vector3(halfSize.x*2, halfSize.y*2, halfSize.z*2),
                    halfSize,
                    mass: mesh.physicsBody?.mass || 1
                });
            }
        }
        return result;
    }

    _isObjectNearby(mesh) {
        const origin = this.upperRoot.getAbsolutePosition();
        return this._distanceToAABBWorld(origin, mesh) < this.grabDistance;
    }

    isMovingTowardsDynamic(mesh) {
        if (!this.movement) return false;
        const moveDir = new BABYLON.Vector3(Math.sin(this.movement.worldRotation), 0, Math.cos(this.movement.worldRotation));
        const toObj = mesh.getAbsolutePosition().subtract(this.upperRoot.getAbsolutePosition()).normalize();
        return BABYLON.Vector3.Dot(moveDir, toObj) > 0.5;
    }

    _classifyObject(targetInfo) {
        const maxDim = Math.max(targetInfo.size.x, targetInfo.size.y, targetInfo.size.z);
        const mass = targetInfo.mass;
        if (maxDim >= this.heavySizeMin || mass >= this.heavyMassMin * 2) return 'heavy';
        if (maxDim > this.lightSizeMax   || mass >= this.heavyMassMin)   return 'medium';
        return 'light';
    }

    toggleGrab() {
        if (this._isRagdollActive()) return;
        if (this.isGrabbing) { this.releaseGrab(); return; }
        if (this.state === 'defending') this.stopDefend();
        const targetInfo = this._getClosestDynamicObject();
        if (!targetInfo) return;
        this.startGrabbing(targetInfo, this._classifyObject(targetInfo));
    }

    startGrabbing(targetInfo, mode) {
        if (this._isRagdollActive() || this.state !== 'idle') return;
        this.state = 'grabbing';
        this.isGrabbing = true;
        this.grabMode = mode;
        this.targetObject = targetInfo.mesh;
        this.grabTargetBody = targetInfo.mesh.physicsBody;
        if (!this.grabTargetBody) return;

        this.savedMeshTag = targetInfo.mesh.metadata?.tag || 'dynamic';
        targetInfo.mesh.metadata.tag = 'grabbed';

        const points = this._computeGrabPoints(targetInfo);
        this.grabPointLocalR = points.localR;
        this.grabPointLocalL = points.localL;
        const invUpper = this.upperRoot.getWorldMatrix().clone().invert();
        const localR = BABYLON.Vector3.TransformCoordinates(points.worldR, invUpper);
        const localL = BABYLON.Vector3.TransformCoordinates(points.worldL, invUpper);
        if (mode === 'light') {
            this._createIKTarget('R', localR);
        } else {
            this._createIKTarget('R', localR);
            this._createIKTarget('L', localL);
        }
        this.grabOffsetLocalR = (mode === 'medium' || mode === 'heavy') ? localR.clone() : null;
        this.grabOffsetLocalL = (mode === 'medium' || mode === 'heavy') ? localL.clone() : null;
        this.springActive = false;
        this._disableObjectCollisions();

        this.savedMaxWalk = this.movement.movement.maxWalkSpeed;
        this.savedMaxRun = this.movement.movement.maxRunSpeed;
        let mult = mode === 'light' ? 0.8 : (mode === 'medium' ? 0.6 : 0.5);
        this.movement.movement.maxWalkSpeed *= mult;
        this.movement.movement.maxRunSpeed *= mult;

        this.handAngles.theta = this.neutralTheta;
        this.handAngles.phi = this.neutralPhi;
        this.isHeavyGrabbing = (mode === 'heavy');

        if (this.animManager.upper['Interact']) {
            this.animManager.startAction('Interact', false, null, { disableBlending: true });
        }
    }

    _computeGrabPoints(targetInfo) {
        const halfSize = targetInfo.halfSize;
        const center = targetInfo.mesh.getAbsolutePosition();
        const toObj = center.subtract(this.upperRoot.getAbsolutePosition()).normalize();
        const right = BABYLON.Vector3.Cross(toObj, BABYLON.Axis.Y).normalize();
        const halfWidth = Math.max(halfSize.x, halfSize.z) * 0.9;
        const worldR = center.add(right.scale(halfWidth));
        const worldL = center.subtract(right.scale(halfWidth));
        const invObj = targetInfo.mesh.getWorldMatrix().clone().invert();
        return {
            worldR, worldL,
            localR: BABYLON.Vector3.TransformCoordinates(worldR, invObj),
            localL: BABYLON.Vector3.TransformCoordinates(worldL, invObj)
        };
    }

    _createIKTarget(side, localPos) {
        const ctrlKey = `ikController${side}`;
        if (this[ctrlKey]) { try { this[ctrlKey].dispose(); } catch(e){} this[ctrlKey] = null; }
        const targetKey = `grabIKTarget${side}`;
        let node = this[targetKey];
        if (!node) {
            node = new BABYLON.TransformNode(`grab_ik_target_${side.toLowerCase()}`, this.scene);
            node.parent = this.upperRoot;
            this[targetKey] = node;
        }
        node.position.copyFrom(localPos);
        const bone = side === 'R' ? this.lowerarmBoneR : this.lowerarmBoneL;
        const pole = side === 'R' ? this.upperarmBoneR : this.upperarmBoneL;
        this[ctrlKey] = new BABYLON.BoneIKController(this.mesh, bone, {
            targetMesh: node,
            poleTargetBone: pole,
            poleAngle: 0,
            bendAxis: new BABYLON.Vector3(0,0,1),
            slerpAmount: 0.95
        });
    }

    _disableObjectCollisions() {
        if (!this.grabTargetBody?.shape) return;
        this.savedCollisionMask = this.grabTargetBody.shape.filterCollideMask;
        this.grabTargetBody.shape.filterCollideMask &= ~(1 << 2);
    }

    _enableObjectCollisions() {
        if (!this.grabTargetBody?.shape || this.savedCollisionMask === null) return;
        this.grabTargetBody.shape.filterCollideMask = this.savedCollisionMask;
        this.savedCollisionMask = null;
    }

    releaseGrab() {
        if (!this.isGrabbing) return;
        this._cleanupGrab();
    }

    throwObject(targetWorldPoint) {
        if (!this.isGrabbing || !this.grabTargetBody) return false;
        const characterPos = this.upperRoot.getAbsolutePosition();
        const direction = targetWorldPoint.subtract(characterPos);
        if (direction.length() < 0.01) return false;
        direction.normalize();
        const body = this.grabTargetBody;
        const mass = body.mass || 1;
        const baseForce = 8.0;
        const force = baseForce * mass;
        if (this.grabMode === 'light') {
            const animName = mass < 5 ? 'Throw Object' : 'OverhandThrow';
            this.animManager.startAction(animName, false, () => {
                if (this.grabTargetBody) this._applyThrowImpulse(direction, force);
                this._cleanupGrab();
            });
            this.stamina.consume(3 + Math.min(mass, 5));
            return true;
        }
        this._applyThrowImpulse(direction, force);
        this._cleanupGrab();
        return true;
    }

    _applyThrowImpulse(direction, force) {
        if (!this.grabTargetBody) return;
        const body = this.grabTargetBody;
        body.applyImpulse(direction.scale(force), this.targetObject.getAbsolutePosition());
        const torque = BABYLON.Vector3.Cross(direction, BABYLON.Axis.Y).normalize().scale(force * 0.15);
        body.applyTorque(torque);
    }

    _cleanupGrab() {
        this._enableObjectCollisions();
        if (this.targetObject && this.savedMeshTag) {
            this.targetObject.metadata.tag = this.savedMeshTag;
        }
        this.savedMeshTag = null;

        if (this.grabIKTargetR) this.grabIKTargetR.position.set(0,0,0);
        if (this.grabIKTargetL) this.grabIKTargetL.position.set(0,0,0);

        this.movement.movement.maxWalkSpeed = this.savedMaxWalk;
        this.movement.movement.maxRunSpeed = this.savedMaxRun;
        this.isHeavyGrabbing = false;
        this.state = 'idle';
        this.isGrabbing = false;
        this.grabMode = null;
        this.springActive = false;
        this.grabOffsetLocalR = null;
        this.grabOffsetLocalL = null;
        this.targetObject = null;
        this.grabTargetBody = null;
    }

    _checkObjectProximity() {
        if (!this.targetObject || !this.movement) return;
        const charPos = this.upperRoot.getAbsolutePosition();
        const dist = this._distanceToAABBWorld(charPos, this.targetObject);
        const minDist = 0.3; // метры
        if (dist < minDist) {
            // Масштабируем скорость: при dist=0 -> 0.3, при dist>=minDist -> 1.0
            const factor = Math.max(0.3, dist / minDist);
            this.movement.movement.maxWalkSpeed = this.savedMaxWalk * factor;
            this.movement.movement.maxRunSpeed = this.savedMaxRun * factor;
        } else {
            this.movement.movement.maxWalkSpeed = this.savedMaxWalk;
            this.movement.movement.maxRunSpeed = this.savedMaxRun;
        }
    }

    _updateGrabbing(deltaTime) {
        if (!this.isGrabbing || !this.targetObject || !this.grabTargetBody) {
            this._silentRelease();
            return;
        }
        if (this.grabMode === 'heavy') {
            const toObj = this.targetObject.getAbsolutePosition().subtract(this.upperRoot.getAbsolutePosition()).normalize();
            const desiredAngle = Math.atan2(toObj.x, toObj.z);
            let diff = desiredAngle - this.movement.worldRotation;
            while (diff > Math.PI) diff -= 2*Math.PI;
            while (diff < -Math.PI) diff += 2*Math.PI;
            const turn = Math.max(-1.5 * deltaTime, Math.min(1.5 * deltaTime, diff));
            this.movement.worldRotation += turn;
            this.movement.targetWorldRotation = this.movement.worldRotation;

            // Адаптивное замедление при приближении объекта
            this._checkObjectProximity();
        } else if (this.grabMode === 'medium') {
            const objWorldPos = this.targetObject.getAbsolutePosition();
            const toObj = objWorldPos.subtract(this.upperRoot.getAbsolutePosition()).normalize();
            const forward = new BABYLON.Vector3(Math.sin(this.movement.worldRotation), 0, Math.cos(this.movement.worldRotation));
            const angle = Math.acos(BABYLON.Vector3.Dot(toObj, forward));
            if (angle > Math.PI / 3) {
                const desiredAngle = Math.atan2(toObj.x, toObj.z);
                let diff = desiredAngle - this.movement.worldRotation;
                while (diff > Math.PI) diff -= 2*Math.PI;
                while (diff < -Math.PI) diff += 2*Math.PI;
                const turn = Math.max(-2.0 * deltaTime, Math.min(2.0 * deltaTime, diff));
                this.movement.worldRotation += turn;
                this.movement.targetWorldRotation = this.movement.worldRotation;
            }
        }

        const ikSpeed = this.grabMode === 'medium' ? 12.0 : (this.grabMode === 'heavy' ? 15.0 : this.ikSpeedBase);
        const handSens = this.grabMode === 'medium' ? this.handSensitivityBase * 2.5 : this.handSensitivityBase;

        if (this.grabMode === 'light') {
            this.handAngles.theta += this.mouseDelta.x * handSens;
            this.handAngles.phi   += this.mouseDelta.y * handSens;
            this.handAngles.phi   = Math.max(0.2, Math.min(Math.PI - 0.2, this.handAngles.phi));
            this.handAngles.theta = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.handAngles.theta));
            const center = new BABYLON.Vector3(0.15, 1.35, 0.20);
            const rx = 0.6, ry = 0.6, rz = 0.6;
            const localTarget = new BABYLON.Vector3(
                center.x + rx * Math.sin(this.handAngles.phi) * Math.sin(this.handAngles.theta),
                center.y + ry * Math.cos(this.handAngles.phi),
                center.z + rz * Math.sin(this.handAngles.phi) * Math.cos(this.handAngles.theta)
            );
            BABYLON.Vector3.SmoothToRef(this.grabIKTargetR.position, localTarget, ikSpeed, deltaTime, this.grabIKTargetR.position);
        } else if (this.grabMode === 'medium') {
            this.handAngles.theta += this.mouseDelta.x * handSens;
            this.handAngles.phi   += this.mouseDelta.y * handSens;
            this.handAngles.phi   = Math.max(0.2, Math.min(Math.PI - 0.2, this.handAngles.phi));
            this.handAngles.theta = Math.max(-1.5, Math.min(1.5, this.handAngles.theta));
            const center = new BABYLON.Vector3(0.15, 1.35, 0.20);
            const rx = 1.0, ry = 1.0, rz = 1.0;
            const mouseOffset = new BABYLON.Vector3(
                rx * Math.sin(this.handAngles.phi) * Math.sin(this.handAngles.theta),
                ry * Math.cos(this.handAngles.phi),
                rz * Math.sin(this.handAngles.phi) * Math.cos(this.handAngles.theta)
            ).subtract(center);
            const maxOffset = 1.2;
            if (mouseOffset.length() > maxOffset) mouseOffset.normalize().scaleInPlace(maxOffset);
            const targetR = this.grabOffsetLocalR.add(mouseOffset);
            const targetL = this.grabOffsetLocalL.add(mouseOffset);
            BABYLON.Vector3.SmoothToRef(this.grabIKTargetR.position, targetR, ikSpeed, deltaTime, this.grabIKTargetR.position);
            BABYLON.Vector3.SmoothToRef(this.grabIKTargetL.position, targetL, ikSpeed, deltaTime, this.grabIKTargetL.position);
        } else if (this.grabMode === 'heavy') {
            if (this.grabOffsetLocalR && this.grabOffsetLocalL) {
                BABYLON.Vector3.SmoothToRef(this.grabIKTargetR.position, this.grabOffsetLocalR, ikSpeed, deltaTime, this.grabIKTargetR.position);
                BABYLON.Vector3.SmoothToRef(this.grabIKTargetL.position, this.grabOffsetLocalL, ikSpeed, deltaTime, this.grabIKTargetL.position);
            }
        }

        if (this.ikControllerR) this.ikControllerR.update();
        if (this.ikControllerL) this.ikControllerL.update();

        if (!this.springActive && this.grabIKTargetR) {
            const handWorldR = this.grabIKTargetR.getAbsolutePosition();
            const objMatrix = this.targetObject.getWorldMatrix();
            const targetWorldR = BABYLON.Vector3.TransformCoordinates(this.grabPointLocalR, objMatrix);
            const distR = BABYLON.Vector3.Distance(handWorldR, targetWorldR);
            let activate = distR < 0.15;
            if (this.grabMode !== 'light' && this.grabIKTargetL) {
                const handWorldL = this.grabIKTargetL.getAbsolutePosition();
                const targetWorldL = BABYLON.Vector3.TransformCoordinates(this.grabPointLocalL, objMatrix);
                const distL = BABYLON.Vector3.Distance(handWorldL, targetWorldL);
                activate = activate && distL < 0.15;
            }
            if (activate) {
                this.springActive = true;
                if (this.grabMode === 'heavy') {
                    this.springStiffness = 800;
                    this.springDamping = 50;
                    this.maxGrabSpeed = 2.0;
                } else if (this.grabMode === 'medium') {
                    this.springStiffness = 400;
                    this.springDamping = 60;
                    this.maxGrabSpeed = 3.0;
                } else {
                    this.springStiffness = 200;
                    this.springDamping = 25;
                    this.maxGrabSpeed = 5.0;
                }
            }
        }

        if (this.springActive && this.grabTargetBody) this._applySpringForces(deltaTime);

        if (this.movement.movementState.isMoving) {
            let rate = this.grabMode === 'heavy' ? 4.0 : (this.grabMode === 'medium' ? 2.0 : 1.0);
            if (this.stamina) {
                this.stamina.consume(rate * deltaTime);
                if (this.stamina.currentStamina <= 0) this._silentRelease();
            }
        }

        if (this.grabMode === 'heavy') {
            const bodyPos = this.targetObject.getAbsolutePosition();
            const halfHeight = this.targetObject.getBoundingInfo().boundingBox.extendSize.y;
            const groundY = this.movement.groundY;
            const objectBottom = bodyPos.y - halfHeight;
            if (objectBottom > groundY + 0.05) {
                const vel = this.grabTargetBody.getLinearVelocity() || BABYLON.Vector3.Zero();
                this.grabTargetBody.applyForce(new BABYLON.Vector3(0, -this.downForceStrength * 0.8, 0).subtract(vel.scale(5)), this.targetObject.getAbsolutePosition());
            }
        }
    }

    _applySpringForces(deltaTime) {
        const body = this.grabTargetBody;
        const objMatrix = this.targetObject.getWorldMatrix();
        const worldGrabR = BABYLON.Vector3.TransformCoordinates(this.grabPointLocalR, objMatrix);
        const handWorldR = this.grabIKTargetR.getAbsolutePosition();
        let stiffness = this.springStiffness;
        let damping = this.springDamping;
        let maxSpeed = this.maxGrabSpeed;

        const errorR = handWorldR.subtract(worldGrabR);
        let totalForce = errorR.scale(stiffness);

        if (this.grabMode !== 'light' && this.grabIKTargetL) {
            const worldGrabL = BABYLON.Vector3.TransformCoordinates(this.grabPointLocalL, objMatrix);
            const handWorldL = this.grabIKTargetL.getAbsolutePosition();
            const errorL = handWorldL.subtract(worldGrabL);
            totalForce.addInPlace(errorL.scale(stiffness * 0.5));
        }

        const vel = body.getLinearVelocity() || BABYLON.Vector3.Zero();
        totalForce.subtractInPlace(vel.scale(damping));

        if (this.grabMode === 'medium') {
            totalForce.y += (body.mass || 1) * 9.81 * 1.1;
        }

        if (totalForce.length() > 0.01) {
            body.applyForce(totalForce, this.targetObject.getAbsolutePosition());
            const speed = vel.length();
            if (speed > maxSpeed) body.setLinearVelocity(vel.normalize().scale(maxSpeed));
        }

        const angVel = body.getAngularVelocity() || BABYLON.Vector3.Zero();
        const angDamping = this.grabMode === 'heavy' ? 0.3 : 0.9;
        body.setAngularVelocity(angVel.scale(angDamping));

        const halfHeight = this.targetObject.getBoundingInfo().boundingBox.extendSize.y;
        const groundY = this.movement.groundY;
        const pos = this.targetObject.position;
        if (pos.y - halfHeight < groundY) pos.y = groundY + halfHeight;

        if (this.grabMode === 'heavy') {
            const forward = new BABYLON.Vector3(Math.sin(this.movement.worldRotation), 0, Math.cos(this.movement.worldRotation));
            const sideVel = vel.subtract(forward.scale(BABYLON.Vector3.Dot(vel, forward)));
            if (sideVel.length() > 0.05) body.applyForce(sideVel.scale(-20), this.targetObject.getAbsolutePosition());
        }
    }

    _silentRelease() { this._cleanupGrab(); }

    _setDefend(active) {
        if (active && !this._defendActive) {
            this.animManager.setForcedUpper('Defend');
            this._defendActive = true;
        } else if (!active && this._defendActive) {
            this.animManager.setForcedUpper(null);
            this._defendActive = false;
        }
    }

    startDefend(objectMesh) {
        if (this._isRagdollActive() || this.state !== 'idle' || this.isGrabbing) return;
        this.state = 'defending';
        this.targetObject = objectMesh;
        this._setDefend(true);
    }

    stopDefend() {
        if (this.state !== 'defending') return;
        this.state = 'idle';
        this.targetObject = null;
        this._setDefend(false);
        this.cooldownTimer = this.defendCooldown;
    }

    update(deltaSec, mouseButtons, mouseX, mouseY, mouseDeltaX, mouseDeltaY) {
        if (this._isRagdollActive()) {
            if (this.isGrabbing) this._silentRelease();
            return;
        }
        if (this.weaponSystem?.isActive) {
            if (this.isGrabbing) this.releaseGrab();
            return;
        }
        if (this.cooldownTimer > 0) this.cooldownTimer -= deltaSec;
        this.mouseDelta.set(mouseDeltaX, mouseDeltaY);

        if (this.isGrabbing) {
            this._updateGrabbing(deltaSec);
            return;
        }

        if (this.state === 'idle') {
            const nearby = this._getAllNearby();
            for (const entry of nearby) {
                if (this.isMovingTowardsDynamic(entry.mesh)) {
                    this.startDefend(entry.mesh);
                    break;
                }
            }
        } else if (this.state === 'defending') {
            const still = this.targetObject && this.isMovingTowardsDynamic(this.targetObject) && this._isObjectNearby(this.targetObject);
            if (!still) this.stopDefend();
        }
    }

    getSpeedMultiplier() {
        if (this.state === 'defending') return 0.7;
        if (this.isGrabbing) {
            if (this.grabMode === 'light') return 0.8;
            if (this.grabMode === 'medium') return 0.6;
            return 0.5;
        }
        return 1.0;
    }

    dispose() {
        if (this.isGrabbing) this.releaseGrab();
        if (this.grabIKTargetR) this.grabIKTargetR.dispose();
        if (this.grabIKTargetL) this.grabIKTargetL.dispose();
        if (this.ikControllerR) try { this.ikControllerR.dispose(); } catch(e){}
        if (this.ikControllerL) try { this.ikControllerL.dispose(); } catch(e){}
    }
}