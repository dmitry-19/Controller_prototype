// js/movement.js
export class MovementSystem {
    constructor(root, capsuleRadius, capsuleHeight, scene, globalScene) {
        this.root = root;
        this.scene = scene;
        this.globalScene = globalScene || scene;
        this.position = new BABYLON.Vector3(0, 0, 0);
        this.inputLocked = false;
        this.movement = {
            forward: false, backward: false, left: false, right: false,
            speed: 0, targetSpeed: 0,
            maxWalkSpeed: 2.2, maxRunSpeed: 5.6,
            acceleration: 8.0, deceleration: 6.0,
            isRunning: false, isCrouching: false
        };
        this.worldRotation = 0;
        this.targetWorldRotation = 0;
        this.movementState = {
            isMoving: false,
            hasVelocity: false,
            moveX: 0, moveY: 0,
            isRunning: false, isCrouching: false
        };
        this.capsuleRadius = capsuleRadius;
        this.capsuleHeight = capsuleHeight;

        this.lowSpeedThreshold = 4.5;
        this.mediumSpeedThreshold = 10.0;

        this.lockedDirection = null;
        this.collisionResponseHandler = null;
        this.isReactingToCollision = false;
        this.collisionCapsuleMesh = null;
        this.slideRotationSpeed = 5.0;

        this.groundY = 0;
        this.currentYOffset = 0;
        this.targetYOffset = 0;
        this.stepHeightMin = 0.15;
        this.stepHeightMax = 0.5;
        this.stepCheckDistance = 0.8;
        this.stepSpeed = 3.0;
        this.isSteppingUp = false;
        this.onLargeStep = null;

        // Поля для внешнего воздействия (автономное поведение)
        this.externalBias = new BABYLON.Vector3(0, 0, 0);
        this.externalSpeedLimit = 1.0;

        // Флаг, что персонаж выполняет уклонение/отступление
        this.isEvading = false;
    }

    setInputLock(locked) {
        this.inputLocked = locked;
        if (locked) {
            this.movement.forward = false;
            this.movement.backward = false;
            this.movement.left = false;
            this.movement.right = false;
            this.movement.isRunning = false;
            this.movement.isCrouching = false;
            this.updateTargetMovement();
        }
    }

    handleMovementInput(inputMap) {
        if (this.inputLocked) return;
        this.movement.forward = !!(inputMap['w'] || inputMap['W'] || inputMap['ArrowUp']);
        this.movement.backward = !!(inputMap['s'] || inputMap['S'] || inputMap['ArrowDown']);
        this.movement.left = !!(inputMap['a'] || inputMap['A'] || inputMap['ArrowLeft']);
        this.movement.right = !!(inputMap['d'] || inputMap['D'] || inputMap['ArrowRight']);
        this.movement.isRunning = !!(inputMap['Shift'] || inputMap['ShiftLeft'] || inputMap['ShiftRight']);
        this.movement.isCrouching = !!(inputMap['Control'] || inputMap['Ctrl'] || inputMap['ControlLeft']);

        // Ограничение движения при тяжёлом захвате
        if (this.globalScene?.dim?.isHeavyGrabbing && this.globalScene.dim.targetObject) {
            const dim = this.globalScene.dim;
            const objPos = dim.targetObject.getAbsolutePosition();
            const toObj = objPos.subtract(this.position).normalize();

            let inputX = 0, inputY = 0;
            if (this.movement.forward) inputY += 1;
            if (this.movement.backward) inputY -= 1;
            if (this.movement.left) inputX -= 1;
            if (this.movement.right) inputX += 1;

            if (inputX !== 0 || inputY !== 0) {
                const inputDir = new BABYLON.Vector3(inputX, 0, inputY).normalize();
                const dot = BABYLON.Vector3.Dot(inputDir, toObj);
                if (dot <= 0.15) {
                    this.movement.forward = false;
                    this.movement.backward = false;
                    this.movement.left = false;
                    this.movement.right = false;
                }
            }
        }

        this.updateTargetMovement();
    }

    updateTargetMovement() {
        let dx = 0, dy = 0;
        if (this.movement.forward) dy += 1;
        if (this.movement.backward) dy -= 1;
        if (this.movement.left) dx -= 1;
        if (this.movement.right) dx += 1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
            dx /= len;
            dy /= len;
            this.targetWorldRotation = Math.atan2(dx, dy);
            this.movement.targetSpeed = this.movement.isCrouching
                ? this.movement.maxWalkSpeed * 0.5
                : (this.movement.isRunning ? this.movement.maxRunSpeed : this.movement.maxWalkSpeed);
            this.movementState.isMoving = true;
            this.movementState.moveX = dx;
            this.movementState.moveY = dy;
        } else {
            this.movement.targetSpeed = 0;
            this.movementState.isMoving = false;
            this.movementState.moveX = 0;
            this.movementState.moveY = 0;
        }
        this.movementState.isRunning = this.movement.isRunning;
        this.movementState.isCrouching = this.movement.isCrouching;
    }

    _getHorizontalCheckPosition() {
        const checkPos = this.position.clone();
        checkPos.y = this.groundY + this.capsuleHeight * 0.5;
        return checkPos;
    }

    raycastObstacle(moveDelta) {
        const checkPos = this._getHorizontalCheckPosition();
        const direction = moveDelta.clone().normalize();
        const distance = moveDelta.length();
        const radius = this.capsuleRadius;

        const ray = new BABYLON.Ray(checkPos, direction, distance + radius);
        const pickInfo = this.scene.pickWithRay(ray, mesh => {
            if (!mesh.isVisible || !mesh.getBoundingInfo) return false;
            const tag = mesh.metadata?.tag;
            return tag === "static";
        });

        if (pickInfo.hit && pickInfo.pickedPoint) {
            const normal = pickInfo.getNormal(true);
            const upDot = BABYLON.Vector3.Dot(normal, BABYLON.Axis.Y);
            if (upDot > 0.7) {
                return { hit: false };
            }
            const hitDistance = BABYLON.Vector3.Distance(checkPos, pickInfo.pickedPoint) - radius;
            return {
                hit: true,
                distance: Math.max(0, hitDistance),
                point: pickInfo.pickedPoint,
                normal: normal
            };
        }
        return { hit: false };
    }

    raycastStep(moveDelta) {
        if (!this.movementState.isMoving || this.movement.speed < 0.1) return null;
        const dir = moveDelta.clone().normalize();
        const start = this._getHorizontalCheckPosition().add(new BABYLON.Vector3(0, 0.2, 0));
        const end = start.add(dir.scale(this.stepCheckDistance));
        end.y -= this.stepHeightMax;
        const ray = new BABYLON.Ray(start, end.subtract(start).normalize(), this.stepCheckDistance);
        const pickInfo = this.scene.pickWithRay(ray, mesh => {
            if (!mesh.isVisible) return false;
            const tag = mesh.metadata?.tag;
            return tag === "static" || tag === "dynamic";
        });
        if (pickInfo.hit && pickInfo.pickedPoint) {
            const normal = pickInfo.getNormal(true);
            const upDot = BABYLON.Vector3.Dot(normal, BABYLON.Axis.Y);
            if (upDot < 0.6) return null;
            const deltaY = pickInfo.pickedPoint.y - this.groundY;
            return { point: pickInfo.pickedPoint, deltaY, normal };
        }
        return null;
    }

    getSlideDirection(moveDir, normal) {
        const dot = BABYLON.Vector3.Dot(moveDir, normal);
        if (dot >= 0) return moveDir.clone().normalize();
        const slide = moveDir.subtract(normal.scale(dot));
        const len = slide.length();
        return len > 0.001 ? slide.scale(1 / len) : BABYLON.Vector3.Zero();
    }

    _checkSideClearance(direction, angleOffsetDeg) {
        const angleRad = angleOffsetDeg * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const leftDir = new BABYLON.Vector3(
            direction.x * cos - direction.z * sin,
            0,
            direction.x * sin + direction.z * cos
        ).normalize();
        const rightDir = new BABYLON.Vector3(
            direction.x * cos + direction.z * sin,
            0,
            -direction.x * sin + direction.z * cos
        ).normalize();
        const checkDist = 0.3;
        const leftHit = this.raycastObstacle(leftDir.scale(checkDist));
        const rightHit = this.raycastObstacle(rightDir.scale(checkDist));
        return !(leftHit.hit || rightHit.hit);
    }

    applyMovementWithCollisionAvoidance(moveDelta, deltaSec) {
        let collision = this.raycastObstacle(moveDelta);
        if (!collision.hit) {
            this.position.addInPlace(moveDelta);
            this.lockedDirection = null;
            return { impacted: false };
        }

        const speed = this.movement.speed;
        const tier = this.getSpeedTier(speed);
        const safeDistance = Math.max(0, collision.distance - 0.15);

        if (tier === 'low') {
            const safeMove = moveDelta.clone().normalize().scale(safeDistance);
            this.position.addInPlace(safeMove);

            let remaining = moveDelta.length() - safeDistance;
            let slideDirection = null;
            if (remaining > 0.01) {
                slideDirection = this.getSlideDirection(moveDelta, collision.normal);
                let slideDelta = slideDirection.scale(remaining);
                let iterations = 3;
                while (iterations-- > 0 && slideDelta.length() > 0.001) {
                    const slideCollision = this.raycastObstacle(slideDelta);
                    if (!slideCollision.hit) {
                        this.position.addInPlace(slideDelta);
                        break;
                    }
                    const slideSafeDist = Math.max(0, slideCollision.distance - 0.15);
                    const slideSafeMove = slideDelta.clone().normalize().scale(slideSafeDist);
                    this.position.addInPlace(slideSafeMove);
                    remaining = slideDelta.length() - slideSafeDist;
                    if (remaining <= 0.01) break;
                    const newSlideDir = this.getSlideDirection(slideDelta, slideCollision.normal);
                    slideDelta = newSlideDir.scale(remaining);
                    slideDirection = newSlideDir;
                }
            }
            if (slideDirection && slideDirection.length() > 0.1) {
                this.alignRotationToSlideDirection(slideDirection, deltaSec);
            }
            this.lockedDirection = collision.normal.clone();
            return { impacted: false };
        }
        else if (tier === 'medium') {
            const safeMove = moveDelta.clone().normalize().scale(safeDistance);
            this.position.addInPlace(safeMove);
            return {
                impacted: true,
                collisionData: collision,
                remainingDelta: moveDelta.length() - safeDistance
            };
        }
        else {
            this.position.addInPlace(moveDelta);
            return {
                impacted: true,
                collisionData: collision,
                remainingDelta: 0
            };
        }
    }

    alignRotationToSlideDirection(slideDir, deltaSec) {
        const targetAngle = Math.atan2(slideDir.x, slideDir.z);
        let diff = targetAngle - this.worldRotation;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const maxRotation = this.slideRotationSpeed * deltaSec;
        const rotationDelta = Math.max(-maxRotation, Math.min(maxRotation, diff));
        this.worldRotation += rotationDelta;
        this.targetWorldRotation = this.worldRotation;
    }

    getSpeedTier(speed) {
        if (speed <= this.lowSpeedThreshold) return 'low';
        if (speed <= this.mediumSpeedThreshold) return 'medium';
        return 'high';
    }

    applyInputLock(inputVector) {
        if (!this.lockedDirection) return inputVector;
        const dot = BABYLON.Vector3.Dot(inputVector, this.lockedDirection);
        if (dot < 0) {
            inputVector.subtractInPlace(this.lockedDirection.scale(dot));
        }
        return inputVector;
    }

    setKinematicColliderActive(active) {
        if (this.collisionCapsuleMesh) {
            this.collisionCapsuleMesh.isVisible = active;
            if (this.collisionCapsuleMesh.physicsBody) {
                this.collisionCapsuleMesh.physicsBody.setEnabled(active);
            }
        }
    }

    updateGroundY() {
        const ray = new BABYLON.Ray(
            this.position.clone().add(new BABYLON.Vector3(0, 0.5, 0)),
            BABYLON.Axis.Y.negate(),
            2.0
        );
        const pick = this.scene.pickWithRay(ray, mesh => {
            if (!mesh.isVisible) return false;
            const tag = mesh.metadata?.tag;
            return tag === "static" || tag === "dynamic" || mesh.name === "ground";
        });
        this.groundY = pick.hit ? pick.pickedPoint.y : 0;
    }

    checkForStep(moveDelta) {
        if (!this.movementState.isMoving || this.movement.speed < 0.1) {
            this.targetYOffset = 0;
            return;
        }

        const stepInfo = this.raycastStep(moveDelta);
        if (stepInfo) {
            const { deltaY, point } = stepInfo;
            if (deltaY > this.stepHeightMin && deltaY <= this.stepHeightMax) {
                if (!this.isSteppingUp && this.onLargeStep) {
                    this.isSteppingUp = true;
                    const foot = this.getLeadingFoot();
                    this.onLargeStep(point, deltaY, foot);
                    setTimeout(() => { this.isSteppingUp = false; }, 800);
                }
            } else if (deltaY > 0.05 && deltaY <= this.stepHeightMin) {
                this.targetYOffset = deltaY;
            } else {
                this.targetYOffset = 0;
            }
        } else {
            this.targetYOffset = 0;
        }
    }

    getLeadingFoot() {
        const moveX = this.movementState.moveX;
        const moveY = this.movementState.moveY;
        return (moveY > 0 || moveX > 0) ? 'right' : 'left';
    }

    update(deltaTimeMs, speedFactor = 1.0, collisionCapsuleMesh = null) {
        const deltaSec = deltaTimeMs / 1000;
        const effectiveTargetSpeed = this.movement.targetSpeed * speedFactor * this.externalSpeedLimit;
        if (Math.abs(effectiveTargetSpeed - this.movement.speed) > 0.01) {
            const accel = effectiveTargetSpeed > this.movement.speed ? this.movement.acceleration : this.movement.deceleration;
            this.movement.speed = BABYLON.Scalar.Lerp(this.movement.speed, effectiveTargetSpeed, accel * deltaSec);
        } else {
            this.movement.speed = effectiveTargetSpeed;
        }
        this.movementState.hasVelocity = Math.abs(this.movement.speed) > 0.01;

        if (!this.lockedDirection) {
            if (Math.abs(this.targetWorldRotation - this.worldRotation) > 0.01) {
                let diff = this.targetWorldRotation - this.worldRotation;
                while (diff > Math.PI) diff -= 2 * Math.PI;
                while (diff < -Math.PI) diff += 2 * Math.PI;
                this.worldRotation += diff * 4.0 * deltaSec;
            }
        }

        const moveDist = this.movement.speed * deltaSec;
        let moveDelta = new BABYLON.Vector3(
            Math.sin(this.worldRotation) * moveDist,
            0,
            Math.cos(this.worldRotation) * moveDist
        );

        // Применяем внешнее смещение (автономное поведение)
        if (this.externalBias.length() > 0.001) {
            moveDelta.addInPlace(this.externalBias.scale(deltaSec * 3.0));
            this.externalBias.scaleInPlace(0.95); // затухание
        }

        if (this.lockedDirection) {
            const testCollision = this.raycastObstacle(moveDelta.clone().normalize().scale(0.3));
            const sideClear = this._checkSideClearance(moveDelta.clone().normalize(), 30);
            if (!testCollision.hit && sideClear) {
                this.lockedDirection = null;
            } else {
                const adjusted = this.applyInputLock(moveDelta.clone());
                moveDelta = adjusted;
            }
        }

        const result = this.applyMovementWithCollisionAvoidance(moveDelta, deltaSec);

        if (result.impacted && this.collisionResponseHandler && !this.isReactingToCollision) {
            const tier = this.getSpeedTier(this.movement.speed);
            if (tier === 'high') {
                this.setKinematicColliderActive(false);
            }
            this.collisionResponseHandler.handleImpact(result.collisionData, this.movement.speed, tier);
            this.inputLocked = true;
            this.isReactingToCollision = true;
        }

        this.updateGroundY();
        this.checkForStep(moveDelta);

        if (Math.abs(this.currentYOffset - this.targetYOffset) > 0.01) {
            const step = Math.sign(this.targetYOffset - this.currentYOffset) * this.stepSpeed * deltaSec;
            this.currentYOffset += step;
            if (Math.abs(this.currentYOffset - this.targetYOffset) < 0.01) {
                this.currentYOffset = this.targetYOffset;
            }
        }

        const newY = this.groundY + this.currentYOffset;
        if (newY > this.position.y) {
            const upRay = new BABYLON.Ray(this.position, BABYLON.Axis.Y, newY - this.position.y + 0.1);
            const pick = this.scene.pickWithRay(upRay, mesh => {
                if (!mesh.isVisible) return false;
                const tag = mesh.metadata?.tag;
                return tag === "static" || tag === "dynamic";
            });
            if (pick.hit) {
                this.currentYOffset = pick.pickedPoint.y - this.groundY - this.capsuleHeight;
                if (this.currentYOffset < 0) this.currentYOffset = 0;
            }
        }
        this.position.y = this.groundY + this.currentYOffset;

        if (this.root) {
            this.root.position.copyFrom(this.position);
            this.root.rotation.y = this.worldRotation;
        }
    }

    getMovementState() {
        return this.movementState;
    }

    reset() {
        this.position.set(0, 0, 0);
        this.worldRotation = 0;
        this.targetWorldRotation = 0;
        this.movement.speed = 0;
        this.movement.targetSpeed = 0;
        this.setInputLock(false);
        this.resetCollisionState();
        this.setKinematicColliderActive(true);
        this.currentYOffset = 0;
        this.targetYOffset = 0;
        this.externalBias.setAll(0);
        this.externalSpeedLimit = 1.0;
        this.isEvading = false;
    }

    resetCollisionState() {
        this.lockedDirection = null;
        this.inputLocked = false;
        this.isReactingToCollision = false;
    }
}