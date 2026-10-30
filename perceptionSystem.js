// js/perceptionSystem.js
// Сканирует окружение и собирает данные об объектах с метаданными.
// Добавлена категория "projectile" для быстрых угроз.

export class PerceptionSystem {
    constructor(scene, characterRoot) {
        this.scene = scene;
        this.characterRoot = characterRoot;
        this.nearRadius = 3.0;
        this.mediumRadius = 10.0;
        this.farRadius = 20.0; // для projectiles (летят быстро, нужно замечать заранее)
        this.updateInterval = 0.1; // секунды
        this._timer = 0;
        this.snapshot = null; // PerceptionSnapshot
    }

    /**
     * @param {number} deltaSec
     * @returns {PerceptionSnapshot|undefined} новый снапшот, если был обновлён
     */
    update(deltaSec) {
        this._timer += deltaSec;
        if (this._timer < this.updateInterval) return undefined;
        this._timer = 0;

        const charPos = this.characterRoot.getAbsolutePosition();
        const threats = [];
        const projectiles = [];
        const sanctuaries = [];
        const relics = [];
        const mirrors = [];
        const voids = [];
        const fogCovers = [];

        for (const mesh of this.scene.meshes) {
            if (!mesh.isVisible || !mesh.metadata) continue;
            const tag = mesh.metadata.tag;
            if (!tag) continue;

            const pos = mesh.getAbsolutePosition();
            const dist = BABYLON.Vector3.Distance(charPos, pos);
            const dir = pos.subtract(charPos).normalize();

            switch (tag) {
                case 'hostile':
                    if (dist <= this.mediumRadius) {
                        threats.push({
                            mesh,
                            distance: dist,
                            direction: dir,
                            subtype: mesh.metadata.subtype || 'angular',
                            attackPattern: mesh.metadata.attackPattern || 'any',
                            damageZone: mesh.metadata.damageZone || 'any',
                            fearIntensity: mesh.metadata.fearIntensity || 5,
                            telegraphProgress: mesh.metadata.telegraphProgress ?? 0,
                            isAttacking: mesh.metadata.isAttacking || false
                        });
                    }
                    break;

                case 'projectile':
                    if (dist <= this.farRadius) {
                        const vel = mesh.physicsBody ? mesh.physicsBody.getLinearVelocity() : BABYLON.Vector3.Zero();
                        const speed = vel.length();
                        const threatDir = speed > 0.1 ? vel.normalize() : dir;
                        projectiles.push({
                            mesh,
                            distance: dist,
                            direction: threatDir,
                            speed,
                            radius: mesh.getBoundingInfo ? mesh.getBoundingInfo().boundingBox.extendSize.x : 0.3
                        });
                    }
                    break;

                case 'sanctuary':
                    if (dist <= this.mediumRadius) {
                        sanctuaries.push({
                            mesh,
                            distance: dist,
                            direction: dir,
                            comfortLevel: mesh.metadata.comfortLevel || 0.5
                        });
                    }
                    break;

                case 'relic':
                    if (dist <= this.mediumRadius) {
                        relics.push({ mesh, distance: dist, direction: dir, memoryType: mesh.metadata.memoryType });
                    }
                    break;

                case 'mirror':
                    if (dist <= this.mediumRadius) {
                        mirrors.push({
                            mesh,
                            distance: dist,
                            direction: dir,
                            selfAwarenessBoost: mesh.metadata.selfAwarenessBoost || 0.2
                        });
                    }
                    break;

                case 'void':
                    if (dist <= this.mediumRadius) {
                        voids.push({
                            mesh,
                            distance: dist,
                            direction: dir,
                            edgeDirection: mesh.metadata.edgeDirection || dir.scale(-1)
                        });
                    }
                    break;

                case 'fog_cover':
                    if (dist <= this.mediumRadius) {
                        fogCovers.push({ mesh, distance: dist, direction: dir, density: mesh.metadata.density || 0.5 });
                    }
                    break;
            }
        }

        this.snapshot = {
            threats,
            projectiles,
            sanctuaries,
            relics,
            mirrors,
            voids,
            fogCovers,
            timestamp: performance.now()
        };
        return this.snapshot;
    }

    dispose() {
        this.snapshot = null;
    }
}