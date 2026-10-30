// js/fogEnemy.js
export class FogEnemy {
    constructor(scene, skeleton, mesh, animationGroups, initialPosition) {
        this.scene = scene;
        this.skeleton = skeleton;
        this.mesh = mesh;
        this.animGroups = animationGroups;
        this.position = initialPosition.clone();
        this.health = 100;
        this.maxHealth = 100;
        this.speed = 2.5;
        this.attackRange = 1.8;
        this.attackDamage = 15;
        this.attackCooldown = 1.2;
        this.lastAttackTime = 0;
        this.state = 'idle';

        // Полупрозрачный меш
        this.mesh.isVisible = true;           // теперь видим
        this.mesh.position = this.position;
        this.mesh.material = this.createPhantomMaterial();
        this.mesh.receiveShadows = false;

        // Корневой узел для перемещения
        this.rootNode = new BABYLON.TransformNode("enemyRoot", scene);
        this.rootNode.position = this.position;

        // Анимации
        this.idleAnim   = this._findAnim('idle');
        this.walkAnim   = this._findAnim('walk');
        this.attackAnim = this._findAnim('attack') || this._findAnim('sword') || this._findAnim('hit');
        this.hurtAnim   = this._findAnim('hit') || this._findAnim('damage');
        this.deathAnim  = this._findAnim('death');

        this.currentAnim = null;
        if (this.idleAnim) {
            this.idleAnim.start(true);
            this.currentAnim = this.idleAnim;
        }

        // Система частиц (три типа)
        this.particlesData = [];
        this.initAdvancedParticles();
    }

    _findAnim(keyword) {
        return this.animGroups.find(ag => ag.name.toLowerCase().includes(keyword));
    }

    createPhantomMaterial() {
        const mat = new BABYLON.StandardMaterial("phantomMat", this.scene);
        mat.diffuseColor  = new BABYLON.Color3(0.05, 0.05, 0.08);
        mat.specularColor = BABYLON.Color3.Black();
        mat.alpha = 0.25;
        mat.emissiveColor = new BABYLON.Color3(0.02, 0.02, 0.04);
        mat.backFaceCulling = false;
        return mat;
    }

    initAdvancedParticles() {
        const bones = this.skeleton.bones;
        const particlesPerBone = 20; // базовое количество частиц каждого типа на кость

        // Создаём шаблоны для SPS
        const templateLarge = BABYLON.MeshBuilder.CreateSphere("tplLarge", { diameter: 0.2 }, this.scene);
        const templateMedium = BABYLON.MeshBuilder.CreateSphere("tplMedium", { diameter: 0.1 }, this.scene);
        const templateSmall = BABYLON.MeshBuilder.CreateBox("tplSmall", { size: 0.06 }, this.scene);
        templateLarge.isVisible = false;
        templateMedium.isVisible = false;
        templateSmall.isVisible = false;

        this.sps = new BABYLON.SolidParticleSystem("fogEnemySPS", this.scene, { updatable: true });

        // Добавляем частицы разных типов для каждой кости
        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            // Пропускаем концевые кости (пальцы и т.п.), если их много
            const name = bone.name.toLowerCase();
            const isImportant = !name.includes('finger') && !name.includes('thumb') && !name.includes('toe');

            const countMult = isImportant ? 1.0 : 0.3;
            const numLarge  = Math.floor(particlesPerBone * 0.15 * countMult);
            const numMedium = Math.floor(particlesPerBone * 0.35 * countMult);
            const numSmall  = Math.floor(particlesPerBone * 0.5  * countMult);

            for (let j = 0; j < numLarge; j++) {
                this.sps.addShape(templateLarge, 1);
                this.particlesData.push({ boneIndex: i, type: 'large', offset: this._randomOffset(0.25), oscSpeed: 0.5 + Math.random() * 1.5, oscAmp: 0.02 + Math.random() * 0.04 });
            }
            for (let j = 0; j < numMedium; j++) {
                this.sps.addShape(templateMedium, 1);
                this.particlesData.push({ boneIndex: i, type: 'medium', offset: this._randomOffset(0.2), oscSpeed: 1.0 + Math.random() * 2.5, oscAmp: 0.03 + Math.random() * 0.06 });
            }
            for (let j = 0; j < numSmall; j++) {
                this.sps.addShape(templateSmall, 1);
                this.particlesData.push({ boneIndex: i, type: 'small', offset: this._randomOffset(0.15), oscSpeed: 2.0 + Math.random() * 4.0, oscAmp: 0.01 + Math.random() * 0.03 });
            }
        }

        templateLarge.dispose();
        templateMedium.dispose();
        templateSmall.dispose();

        this.sps.buildMesh();
        this.spsMesh = this.sps.mesh;
        this.spsMesh.material = this.createParticleMaterial();

        this.updateParticles(0);
        this.sps.setParticles();
    }

    _randomOffset(maxRadius) {
        return new BABYLON.Vector3(
            (Math.random() - 0.5) * maxRadius,
            (Math.random() - 0.5) * maxRadius,
            (Math.random() - 0.5) * maxRadius
        );
    }

    createParticleMaterial() {
        // Используем текстуру с мягким пятном для всех частиц
        const mat = new BABYLON.StandardMaterial("particleMat", this.scene);
        mat.diffuseTexture = new BABYLON.Texture("https://assets.babylonjs.com/textures/flare.png", this.scene);
        mat.emissiveColor = new BABYLON.Color3(0.2, 0.25, 0.4);
        mat.alpha = 0.4;
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.needDepthPrePass = false;
        return mat;
    }

    updateParticles(deltaTime) {
        const time = performance.now() * 0.001;
        const particles = this.sps.particles;
        const bones = this.skeleton.bones;
        const data = this.particlesData;

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const d = data[i];
            const bone = bones[d.boneIndex];
            if (!bone) continue;

            const boneWorld = bone.getAbsolutePosition(this.mesh);
            const osc = Math.sin(time * d.oscSpeed + i) * d.oscAmp;
            const offset = d.offset.clone().scale(1 + osc * 5);
            p.position.copyFrom(boneWorld).addInPlace(offset);

            // Разные цвета/размеры в зависимости от типа
            if (d.type === 'large') {
                p.color = new BABYLON.Color4(0.2, 0.25, 0.4, 0.3);
                p.scale.setAll(0.8 + Math.random() * 0.3);
            } else if (d.type === 'medium') {
                p.color = new BABYLON.Color4(0.3, 0.4, 0.6, 0.5);
                p.scale.setAll(0.5 + Math.random() * 0.4);
            } else {
                // small spark
                p.color = new BABYLON.Color4(0.5, 0.6, 0.8, 0.7);
                p.scale.setAll(0.3 + Math.random() * 0.4);
            }
        }
        this.sps.setParticles();
    }

    setState(newState) {
        if (this.state === newState) return;
        this.state = newState;

        if (this.currentAnim) {
            this.currentAnim.stop();
        }

        switch (newState) {
            case 'idle': this.currentAnim = this.idleAnim; break;
            case 'walk': this.currentAnim = this.walkAnim; break;
            case 'attack':
                this.currentAnim = this.attackAnim;
                if (this.attackAnim) {
                    this.attackAnim.start(false);
                    this.attackAnim.onAnimationGroupEndObservable.addOnce(() => {
                        this.setState('walk');
                    });
                }
                break;
            case 'hurt':
                this.currentAnim = this.hurtAnim;
                if (this.hurtAnim) {
                    this.hurtAnim.start(false);
                    this.hurtAnim.onAnimationGroupEndObservable.addOnce(() => {
                        this.setState('walk');
                    });
                }
                break;
            case 'dead':
                this.currentAnim = this.deathAnim;
                if (this.deathAnim) {
                    this.deathAnim.start(false);
                    this.deathAnim.onAnimationGroupEndObservable.addOnce(() => {
                        this.dispose();
                    });
                } else {
                    // Нет анимации смерти — просто исчезаем через 1 сек
                    setTimeout(() => this.dispose(), 1000);
                }
                break;
        }

        if (this.currentAnim && !['attack', 'hurt', 'dead'].includes(newState)) {
            this.currentAnim.start(true);
        }
    }

    updateBehavior(playerPosition, deltaTime) {
        if (this.health <= 0) {
            if (this.state !== 'dead') this.setState('dead');
            return;
        }

        const dist = BABYLON.Vector3.Distance(this.position, playerPosition);
        const now = performance.now() / 1000;

        if (dist > 15) {
            if (this.state !== 'idle') this.setState('idle');
            return;
        }

        if (dist <= this.attackRange) {
            if (this.state !== 'attack' && this.state !== 'hurt') {
                if (now - this.lastAttackTime > this.attackCooldown) {
                    this.lastAttackTime = now;
                    this.setState('attack');
                    if (this.onAttack) this.onAttack(this.attackDamage);
                }
            }
        } else if (dist <= 15) {
            if (this.state !== 'walk') this.setState('walk');
            const direction = playerPosition.subtract(this.position).normalize();
            this.position.addInPlace(direction.scale(this.speed * deltaTime));
            this.rootNode.position = this.position;
            this.mesh.position = this.position;
            const angle = Math.atan2(direction.x, direction.z);
            this.rootNode.rotation.y = angle;
            this.mesh.rotation.y = angle;
        }
    }

    takeDamage(amount) {
        this.health -= amount;
        if (this.health <= 0) {
            this.setState('dead');
        } else {
            this.setState('hurt');
        }
        // Визуальная вспышка
        if (this.spsMesh?.material) {
            this.spsMesh.material.emissiveColor = new BABYLON.Color3(0.8, 0.2, 0.2);
            setTimeout(() => {
                if (this.spsMesh?.material) {
                    this.spsMesh.material.emissiveColor = new BABYLON.Color3(0.2, 0.25, 0.4);
                }
            }, 200);
        }
    }

    getPosition() {
        return this.rootNode.position;
    }

    dispose() {
        if (this.sps) this.sps.dispose();
        if (this.spsMesh) this.spsMesh.dispose();
        if (this.mesh) this.mesh.dispose();
        if (this.rootNode) this.rootNode.dispose();
    }
}