// js/projectileSpawner.js
export class ProjectileSpawner {
    constructor(scene, targetRoot, options = {}) {
        this.scene = scene;
        this.targetRoot = targetRoot;
        this.spawnInterval = options.spawnInterval ?? 2.0;
        this.projectileSpeed = options.projectileSpeed ?? 15;  // увеличена скорость
        this.projectileMass = options.projectileMass ?? 2.0;
        this.projectileRadius = options.projectileRadius ?? 0.3;
        this.spawnDistance = options.spawnDistance ?? 6.0;      // уменьшена дистанция, чтобы быстрее долетать
        this._timer = 0;
        this.projectiles = [];
    }

    update(deltaSec) {
        this._timer += deltaSec;
        if (this._timer >= this.spawnInterval) {
            this._timer -= this.spawnInterval;
            this.spawnProjectile();
        }
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            if (!p.mesh || p.mesh.isDisposed()) {
                this.projectiles.splice(i, 1);
                continue;
            }
            if (BABYLON.Vector3.Distance(p.mesh.position, this.targetRoot.getAbsolutePosition()) > 40) {
                p.mesh.dispose();
                this.projectiles.splice(i, 1);
            }
        }
    }

    spawnProjectile() {
        if (!this.targetRoot) return;
        const targetPos = this.targetRoot.getAbsolutePosition();
        const angle = Math.random() * Math.PI * 2;
        // Спавним чуть выше и вокруг персонажа
        const spawnPos = targetPos.add(new BABYLON.Vector3(
            Math.cos(angle) * this.spawnDistance,
            3 + Math.random() * 2,   // высота 3-5 метров
            Math.sin(angle) * this.spawnDistance
        ));

        const mesh = BABYLON.MeshBuilder.CreateSphere("projectile", { diameter: this.projectileRadius * 2 }, this.scene);
        mesh.position = spawnPos;
        const mat = new BABYLON.StandardMaterial("projMat", this.scene);
        mat.diffuseColor = new BABYLON.Color3(1, 1, 0);
        mat.emissiveColor = new BABYLON.Color3(0.8, 0.4, 0);
        mesh.material = mat;
        mesh.metadata = { tag: "projectile" };

        const aggregate = new BABYLON.PhysicsAggregate(mesh, BABYLON.PhysicsShapeType.SPHERE, { mass: this.projectileMass, restitution: 0.3, friction: 0.2 }, this.scene);
        aggregate.body.tag = "projectile";

        const toTarget = targetPos.subtract(spawnPos);
        const dir = toTarget.normalize();
        aggregate.body.setLinearVelocity(dir.scale(this.projectileSpeed));



        aggregate.body.setCollisionCallbackEnabled(true);
        aggregate.body.getCollisionObservable().add((collisionEvent) => {
            const other = collisionEvent.collidedAgainst;
            if (other?.tag === "ragdollPart" && this.scene.reactionSystem) {
                this.scene.reactionSystem.registerHit({
                    force: collisionEvent.impulse ?? 5,
                    point: collisionEvent.point,
                    normal: collisionEvent.normal || BABYLON.Vector3.Zero(),
                    bodyPart: other.transformNode?.name || 'unknown',
                    body: other
                });
                console.log(`[Projectile] hit ${other.transformNode.name}`);
            }
            setTimeout(() => {
                mesh.dispose();
            }, 100);
        });

        this.projectiles.push({ mesh, aggregate });
    }

    dispose() {
        this.projectiles.forEach(p => p.mesh.dispose());
        this.projectiles = [];
    }
}