// js/hostileAI.js
export class HostileCubeAI {
    constructor(mesh, scene, characterRoot) {
        this.mesh = mesh;
        this.scene = scene;
        this.characterRoot = characterRoot;
        this.state = 'idle';
        this.attackRange = 2.5;
        this.chaseRange = 8.0;
        this.speed = 2.0;
        this.attackDamage = 15;
        this.telegraphTime = 0.6;
        this.attackCooldown = 1.2;
        this._timer = 0;
        this._telegraphProgress = 0;
        this._attackDealt = false;

        if (!mesh.physicsBody) {
            new BABYLON.PhysicsAggregate(mesh, BABYLON.PhysicsShapeType.BOX, { mass: 20, restitution: 0.2, friction: 0.8 }, scene);
        }

        this.mesh.metadata = this.mesh.metadata || {};
        this.mesh.metadata.subtype = this.mesh.metadata.subtype || 'angular';
        this.mesh.metadata.attackPattern = this.mesh.metadata.attackPattern || 'swipe_left';
        this.mesh.metadata.damageZone = this.mesh.metadata.damageZone || 'head';
        this.mesh.metadata.fearIntensity = this.mesh.metadata.fearIntensity || 6;
        this.mesh.metadata.isAttacking = false;
        this.mesh.metadata.telegraphProgress = 0;
    }

    update(deltaSec) {
        if (!this.characterRoot) return;
        const charPos = this.characterRoot.getAbsolutePosition();
        const myPos = this.mesh.getAbsolutePosition();
        const dist = BABYLON.Vector3.Distance(charPos, myPos);

        switch (this.state) {
            case 'idle':
                if (dist <= this.chaseRange) {
                    this.state = 'chase';
                    console.log(`[HostileAI] ${this.mesh.name} entering chase`);
                }
                break;
            case 'chase':
                if (dist > this.chaseRange * 1.2) {
                    this.state = 'idle';
                    this._stopMove();
                    console.log(`[HostileAI] ${this.mesh.name} returning to idle`);
                } else if (dist <= this.attackRange) {
                    this.state = 'attack';
                    this._timer = 0;
                    this._telegraphProgress = 0;
                    this._attackDealt = false;
                    this._stopMove();
                    console.log(`[HostileAI] ${this.mesh.name} beginning attack telegraph`);
                } else {
                    const dir = charPos.subtract(myPos).normalize();
                    if (this.mesh.physicsBody) {
                        this.mesh.physicsBody.setLinearVelocity(dir.scale(this.speed));
                    } else {
                        this.mesh.position.addInPlace(dir.scale(this.speed * deltaSec));
                    }
                    this.mesh.lookAt(charPos);
                }
                break;
            case 'attack':
                this._timer += deltaSec;
                if (!this._attackDealt) {
                    this._telegraphProgress = Math.min(1.0, this._timer / this.telegraphTime);
                    this.mesh.metadata.isAttacking = true;
                    this.mesh.metadata.telegraphProgress = this._telegraphProgress;
                    if (!this._telegraphVisual) {
                        this._telegraphVisual = true;
                        this.mesh.scaling.setAll(1.3);
                    }
                    if (this._timer >= this.telegraphTime) {
                        this._dealDamage();
                        this._attackDealt = true;
                        this._timer = 0;
                        this.mesh.scaling.setAll(0.7);
                        console.log(`[HostileAI] ${this.mesh.name} attack hit!`);
                    }
                } else {
                    this._timer += deltaSec;
                    if (this._timer >= 0.2) {
                        this.state = 'cooldown';
                        this._timer = 0;
                        this.mesh.metadata.isAttacking = false;
                        this.mesh.metadata.telegraphProgress = 0;
                        this.mesh.scaling.setAll(1.0);
                        this._telegraphVisual = false;
                    }
                }
                break;
            case 'cooldown':
                this._timer += deltaSec;
                if (this._timer >= this.attackCooldown) {
                    this.state = 'idle';
                    this._timer = 0;
                    console.log(`[HostileAI] ${this.mesh.name} cooldown finished`);
                }
                break;
        }
    }

    _dealDamage() {
        const myPos = this.mesh.getAbsolutePosition();
        const damageZone = this.mesh.metadata.damageZone || 'head';
        const bodies = this.scene.getPhysicsEngine()?.getBodies();
        if (!bodies) return;

        // Собираем подходящие по тэгу тела, отсортированные по расстоянию до врага
        const candidates = [];
        for (const body of bodies) {
            if (body.tag !== 'ragdollPart') continue;
            const bodyPos = body.transformNode.getAbsolutePosition();
            const dist = BABYLON.Vector3.Distance(myPos, bodyPos);
            if (dist < this.attackRange + 1.0) {
                // Определяем зону тела по имени кости (как в ReactionSystem)
                const boneName = body.transformNode.name.toLowerCase();
                let zone = 'other';
                if (boneName.includes('head')) zone = 'head';
                else if (boneName.includes('neck')) zone = 'neck';
                else if (boneName.includes('spine') || boneName.includes('chest') || boneName.includes('pelvis')) zone = 'torso';
                else if (boneName.includes('thigh') || boneName.includes('calf') || boneName.includes('foot')) zone = 'leg';
                else if (boneName.includes('upperarm') || boneName.includes('lowerarm') || boneName.includes('hand')) zone = 'arm';
                candidates.push({ body, bodyPos, dist, zone });
            }
        }
        if (candidates.length === 0) return;

        // Предпочитаем кости, чья зона совпадает с damageZone врага
        const preferred = candidates.filter(c => c.zone === damageZone);
        const target = preferred.length > 0 ? preferred[0] : candidates.reduce((a, b) => a.dist < b.dist ? a : b);

        const dir = target.bodyPos.subtract(myPos).normalize();
        const impulse = dir.scale(this.attackDamage * 0.8);
        target.body.applyImpulse(impulse, target.bodyPos);

        if (this.scene.reactionSystem) {
            this.scene.reactionSystem.registerHit({
                force: this.attackDamage,
                point: target.bodyPos,
                normal: dir,
                bodyPart: target.body.transformNode.name,
                body: target.body
            });
        }
        console.log(`[HostileAI] dealt ${this.attackDamage} damage to ${target.body.transformNode.name} (zone: ${target.zone})`);
    }

    _stopMove() {
        if (this.mesh.physicsBody) {
            this.mesh.physicsBody.setLinearVelocity(BABYLON.Vector3.Zero());
        }
    }

    dispose() {}
}