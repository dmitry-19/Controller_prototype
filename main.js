// js/main.js
import { loadModelOnce, centerAndScale, findBone, splitBoneNames, createMarkers, createUpTargets, createCollisionCapsule } from './utils.js';
import { MovementSystem } from './movement.js';
import { AnimationManager } from './animationManager.js';
import { StateMachine, STATE_NAMES, IdleState, MoveState, ActionState, ImpactState, StruggleState, KnockdownState, GetUpState, RagdollState, DefendState, StumbleState, RagdollImpactState } from './stateMachine.js';
import { buildRagdollConfig, stabilizeBodies, ReactionSystem, createClavicleStabilizer } from './ragdollPhysics.js';
import { WeaponSystem } from './weapon-system.js';
import { StaminaSystem } from './staminaSystem.js';
import { CollisionResponseHandler } from './collisionResponse.js';
import { LegIK } from './ikSystem.js';
import { DynamicInteractionManager } from './dynamicInteraction.js';
import { HostileCubeAI } from './hostileAI.js';
import { HealthSystem } from './healthSystem.js';
import { ProjectileSpawner } from './projectileSpawner.js';
import { PerceptionSystem } from './perceptionSystem.js';
import { AutonomousBehaviour } from './autonomousBehaviour.js';
import { EpisodicMemory } from './episodicMemory.js';
import { PerceivedCondition } from './perceivedCondition.js';
import { TrustModel } from './trustModel.js';
import { KinematicRagdollLayer } from './krl.js';

const canvas = document.getElementById('canvas');
const fileInput = document.getElementById('file-input');
const statusDiv = document.getElementById('status');
const resetBtn = document.getElementById('reset-btn');
const skeletonToggle = document.getElementById('skeleton-toggle');
const markerToggle = document.getElementById('marker-toggle');
const idleStatusDiv = document.getElementById('idle-status');

let scene, engine, camera;
let characterRoot, upperRoot, lowerRoot;
let upperSkeleton, lowerSkeleton;
let meshUpper, meshLower;
let spineBoneUpper, spineBoneLower;
let dynamicMesh, dynamicSkeleton, currentRagdoll;
let boneBodyMap = new Map();
let markers = [], upTargets = [];
let upperAnimGroups = {}, lowerAnimGroups = {};
let movementSystem, animManager, reactionSystem, stateMachine, staminaSystem, healthSystem;
let collisionCapsule, collisionCapsuleMesh;
let idleAnimations = [], currentIdleIndex = 0;
let markersVisible = true;
let weaponSystem;
let isLeftMouseDown = false;
let isRightMouseDown = false;
let mouseX = 0, mouseY = 0;
let mouseDeltaX = 0, mouseDeltaY = 0;

// Новые системы
let krl, perceptionSystem, autonomousBehaviour, episodicMemory, perceivedCondition, trustModel;

let hostileAIs = [];
let projectileSpawner;

let savedSensX, savedSensY, savedPanning;

const BASE_MAX_WALK = 2.2;
const BASE_MAX_RUN = 5.6;

window.gameplayMode = 1; // 1 – марионетка, 2 – сопротивление
window.getGroundPointUnderCursor = () => null;

async function initScene() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new BABYLON.Color4(0.05, 0.05, 0.1, 1);
    scene.animationPropertiesOverride = new BABYLON.AnimationPropertiesOverride();
    scene.animationPropertiesOverride.enableBlending = true;
    scene.animationPropertiesOverride.blendingSpeed = 0.2;

    const havok = await HavokPhysics();
    const physics = new BABYLON.HavokPlugin(true, havok);
    await scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), physics);

    camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 8, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.checkCollisions = true;
    camera.applyGravity = true;
    camera.ellipsoid = new BABYLON.Vector3(0.5, 1, 0.5);
    scene.collisionsEnabled = true;
    scene.gravity = new BABYLON.Vector3(0, -0.15, 0);

    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(1, 1, 0), scene);

    createGround();
    createTestObjects();

    window.getGroundPointUnderCursor = () => {
        const rect = canvas.getBoundingClientRect();
        const mx = mouseX - rect.left;
        const my = mouseY - rect.top;
        const ray = scene.createPickingRay(mx, my, BABYLON.Matrix.Identity(), camera);
        const ground = scene.getMeshByName('ground');
        if (ground) {
            const pick = scene.pickWithRay(ray, mesh => mesh === ground);
            if (pick?.hit) return pick.pickedPoint;
        }
        return null;
    };

    setupInput();
    setupMouse();

    staminaSystem = new StaminaSystem();
    healthSystem = new HealthSystem(staminaSystem);
    scene.healthSystem = healthSystem;

    // Новые системы второго этапа
    episodicMemory = new EpisodicMemory();
    perceivedCondition = new PerceivedCondition(healthSystem, staminaSystem);
    trustModel = new TrustModel(0.6);

    const staminaBar = document.getElementById('stamina-bar');
    const staminaText = document.getElementById('stamina-text');

    scene.onBeforeRenderObservable.add(() => {
        if (!characterRoot || !movementSystem || !animManager || !reactionSystem || !stateMachine) return;

        const deltaTime = engine.getDeltaTime();
        const deltaSec = deltaTime / 1000;

        // Обновление ИИ враждебных кубов
        hostileAIs.forEach(ai => ai.update(deltaSec));

        // Обновление снарядов
        if (projectileSpawner) projectileSpawner.update(deltaSec);

        const currentSpeed = movementSystem.movement.speed;
        const maxSpeed = movementSystem.movement.isRunning ? movementSystem.movement.maxRunSpeed : movementSystem.movement.maxWalkSpeed;
        const speedRatio = maxSpeed > 0 ? currentSpeed / maxSpeed : 0;
        const lowerAnimSpeed = speedRatio;
        const upperAnimSpeed = 0.5 + speedRatio * 0.5;
        animManager.setAnimationSpeed(upperAnimSpeed, lowerAnimSpeed);

        staminaSystem.update(deltaSec, movementSystem.movementState.isMoving, movementSystem.movement.isRunning, movementSystem.movement.isCrouching);

        // Ограничение стамины по здоровью
        const maxStamina = healthSystem.getMaxStamina();
        if (staminaSystem.currentStamina > maxStamina) {
            staminaSystem.currentStamina = maxStamina;
        }

        // Проверка убежищ для регенерации
        let isInSanctuary = false;
        for (const mesh of scene.meshes) {
            if (mesh.metadata?.tag === 'sanctuary') {
                if (BABYLON.Vector3.Distance(characterRoot.position, mesh.getAbsolutePosition()) < 2.5) {
                    isInSanctuary = true;
                    break;
                }
            }
        }
        healthSystem.update(deltaSec, isInSanctuary);

        const staminaPercent = staminaSystem.getNormalized();
        staminaBar.style.width = (staminaPercent * 100) + '%';
        staminaText.textContent = `${Math.floor(staminaSystem.currentStamina)}/${Math.floor(maxStamina)}`;

        const staminaSpeedFactor = staminaSystem.getSpeedMultiplier();
        const dimSpeedMult = scene.dim ? scene.dim.getSpeedMultiplier() : 1.0;
        movementSystem.movement.maxWalkSpeed = BASE_MAX_WALK * staminaSpeedFactor * dimSpeedMult;
        movementSystem.movement.maxRunSpeed = BASE_MAX_RUN * staminaSpeedFactor * dimSpeedMult;

        if (!stateMachine.currentState || stateMachine.currentState.statePdFactor === null) {
            stateMachine.pdStrengthTarget = staminaSystem.getPdStrengthMultiplier();
        }

        if (Math.abs(stateMachine.pdStrength - stateMachine.pdStrengthTarget) > 0.01) {
            const speed = 5.0;
            stateMachine.pdStrength += (stateMachine.pdStrengthTarget - stateMachine.pdStrength) * speed * deltaSec;
            stateMachine.pdStrength = Math.max(0, Math.min(1, stateMachine.pdStrength));
        }

        if (collisionCapsule && characterRoot) {
            collisionCapsule.position.copyFrom(characterRoot.position);
            collisionCapsule.rotation.y = characterRoot.rotation.y;
        }

        if (window.__inputMap) {
            movementSystem.handleMovementInput(window.__inputMap);
        }

        movementSystem.update(deltaTime, 1.0, collisionCapsuleMesh);

        // Обновление систем этапа 2, если режим активен
        if (window.gameplayMode === 2) {
            if (krl) krl.update(deltaSec);
            if (perceptionSystem) perceptionSystem.update(deltaSec);
            if (autonomousBehaviour) {
                const playerActive = movementSystem.movementState.isMoving || (window.__inputMap && Object.values(window.__inputMap).some(v => v));
                autonomousBehaviour.update(deltaSec, playerActive);
            }
            // Обновление субъективного состояния
            if (perceivedCondition) perceivedCondition.update(deltaSec);
        }

        reactionSystem.update(deltaSec);
        stateMachine.update(deltaSec);

        if (scene.dim && scene.dim.state !== 'grabbing') {
            reactionSystem.checkBalance(markers, boneBodyMap, stateMachine.pdStrength);
        }

        if (stateMachine.currentState) {
            let desiredUpper = null, desiredLower = null;
            if (typeof stateMachine.currentState.getDesiredUpper === 'function') desiredUpper = stateMachine.currentState.getDesiredUpper();
            if (typeof stateMachine.currentState.getDesiredLower === 'function') desiredLower = stateMachine.currentState.getDesiredLower();

            if (desiredLower === null && stateMachine.currentState.name !== STATE_NAMES.ACTION && stateMachine.currentState.name !== STATE_NAMES.RAGDOLL) {
                const moveState = movementSystem.getMovementState();
                const isLow = staminaSystem.isLow;
                desiredLower = animManager.getDesiredLowerFromMovement(moveState, isLow ? 60 : 0);
            }

            if (desiredUpper === null && stateMachine.currentState.name !== STATE_NAMES.ACTION && stateMachine.currentState.name !== STATE_NAMES.RAGDOLL) {
                const weaponDrawn = weaponSystem?.isActive ?? false;
                desiredUpper = animManager.getDesiredUpperFromState(stateMachine.currentState.name, staminaSystem.isLow ? 60 : 0, weaponDrawn);
                if (!desiredUpper && desiredLower) desiredUpper = desiredLower;
            }

            if (!weaponSystem?.isActive) {
                if (desiredUpper || desiredLower) animManager.setBaseAnimations(desiredUpper, desiredLower);
            } else {
                if (desiredLower) animManager.setBaseAnimations(null, desiredLower);
            }

            if (
                stateMachine.currentState.name === STATE_NAMES.IDLE ||
                stateMachine.currentState.name === STATE_NAMES.MOVE
            ) {
                if (!animManager.currentUpperBase && !animManager.upperAction) {
                    animManager.startUpperBase('Idle_Loop');
                }
            }
        }

        if (spineBoneUpper && spineBoneLower && meshUpper && meshLower && characterRoot) {
            const posUpperWorld = spineBoneUpper.getAbsolutePosition(meshUpper);
            const posLowerWorld = spineBoneLower.getAbsolutePosition(meshLower);
            const invCharMatrix = characterRoot.getWorldMatrix().clone().invert();
            const posUpperInChar = BABYLON.Vector3.TransformCoordinates(posUpperWorld, invCharMatrix);
            const posLowerInChar = BABYLON.Vector3.TransformCoordinates(posLowerWorld, invCharMatrix);
            const delta = posLowerInChar.subtract(posUpperInChar);
            upperRoot.position.addInPlace(delta);
        }

        // PD-контроллер с учётом KRL (или без)
        const charWorldMat = characterRoot.getWorldMatrix();
        markers.forEach((marker) => {
            const boneName = marker.name.replace('marker_', '');
            const dynBody = boneBodyMap.get(boneName);
            if (!dynBody) return;

            const animTarget = marker.getAbsolutePosition();
            const currentPos = dynBody.transformNode.getAbsolutePosition();

            let targetPos;
            if (window.gameplayMode === 2 && krl) {
                // Если KRL даёт целевую позицию, используем её, иначе анимационный маркер
                const krlTarget = krl.getTargetPosition(boneName);
                targetPos = krlTarget ? krlTarget : animTarget;
            } else {
                targetPos = animTarget;
            }

            const error = targetPos.subtract(currentPos);

            let stiffness = 500 * stateMachine.pdStrength;
            let damping = 60 * Math.sqrt(stateMachine.pdStrength);
            const maxForce = 2000 * stateMachine.pdStrength;

            const velocity = dynBody.getLinearVelocity();
            let force = error.scale(stiffness).subtract(velocity.scale(damping));

            const upInfo = upTargets.find(u => u.bone.name === boneName);
            if (upInfo) {
                const upTargetPos = upInfo.targetNode.getAbsolutePosition();
                const upError = upTargetPos.subtract(currentPos);
                force.addInPlace(upError.scale(upInfo.stiffness * stateMachine.pdStrength));
            }

            if (force.length() > maxForce) force = force.normalize().scale(maxForce);
            dynBody.applyForce(force, currentPos);
        });

        let weaponMouseDeltaX = 0, weaponMouseDeltaY = 0;
        if (window.__mouseDelta) {
            weaponMouseDeltaX = window.__mouseDelta.x;
            weaponMouseDeltaY = window.__mouseDelta.y;
            window.__mouseDelta = null;
        }
        if (weaponSystem) {
            weaponSystem.update(deltaSec, weaponMouseDeltaX, weaponMouseDeltaY, mouseX, mouseY, isLeftMouseDown, isRightMouseDown);
        }

        if (legIK) {
            legIK.update(deltaSec, movementSystem);
        }

        if (scene.dim) {
            scene.dim.update(deltaSec, { right: isRightMouseDown, left: isLeftMouseDown }, mouseX, mouseY, mouseDeltaX, mouseDeltaY);
        }

        // Обновление статусной строки
        let statusStr = `HP: ${healthSystem.currentHealth.toFixed(0)}/${healthSystem.maxHealth} | Stam: ${staminaSystem.currentStamina.toFixed(0)}/${maxStamina.toFixed(0)}`;
        if (window.gameplayMode === 2 && perceivedCondition) {
            statusStr += ` | Felt HP: ${perceivedCondition.perceivedHealth.toFixed(0)} Felt Stam: ${perceivedCondition.perceivedStamina.toFixed(0)}`;
        }
        if (window.gameplayMode === 2 && autonomousBehaviour) {
            statusStr += ` | Fear: ${autonomousBehaviour.fearLevel.toFixed(2)} Trust: ${trustModel.getTrust().toFixed(2)} Action: ${autonomousBehaviour.currentAction}`;
        }
        statusDiv.innerHTML = statusStr;
    });

    engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', () => engine.resize());
}

function createGround() {
    const g = BABYLON.MeshBuilder.CreateGround("ground", { width: 50, height: 50 }, scene);
    g.position.y = -0.2;
    const mat = new BABYLON.StandardMaterial("gMat", scene);
    mat.diffuseColor = new BABYLON.Color3(0.15, 0.15, 0.2);
    g.material = mat;
    const groundAgg = new BABYLON.PhysicsAggregate(g, BABYLON.PhysicsShapeType.BOX, { mass: 0, restitution: 0.1, friction: 0.9 }, scene);
    groundAgg.body.tag = "static";
    g.metadata = { tag: "static" };
    return g;
}

function createTestObjects() {
    const redMat = new BABYLON.StandardMaterial("redMat", scene); redMat.diffuseColor = new BABYLON.Color3(1,0.2,0.2);
    const blueMat = new BABYLON.StandardMaterial("blueMat", scene); blueMat.diffuseColor = new BABYLON.Color3(0.2,0.2,1);
    const greenMat = new BABYLON.StandardMaterial("greenMat", scene); greenMat.diffuseColor = new BABYLON.Color3(0.2,1,0.2);
    const yellowMat = new BABYLON.StandardMaterial("yellowMat", scene); yellowMat.diffuseColor = new BABYLON.Color3(1,1,0.2);
    const stepMat = new BABYLON.StandardMaterial("stepMat", scene); stepMat.diffuseColor = new BABYLON.Color3(0.6, 0.3, 0.1);

    // Враждебный куб 1 (обычный враг) – динамический
    const boxHostile1 = BABYLON.MeshBuilder.CreateBox("boxHostile1", { size: 1.5 }, scene);
    boxHostile1.position.set(3, 0.75, 2);
    boxHostile1.material = redMat;
    boxHostile1.metadata = {
        tag: "hostile",
        subtype: "angular",
        attackPattern: "swipe_left",
        damageZone: "head",
        fearIntensity: 6,
        isAttacking: false,
        telegraphProgress: 0
    };
    new BABYLON.PhysicsAggregate(boxHostile1, BABYLON.PhysicsShapeType.BOX, { mass: 20, restitution: 0.2, friction: 0.8 }, scene);
    hostileAIs.push(new HostileCubeAI(boxHostile1, scene, null));

    // Враждебный куб 2 (босс) – динамический
    const boxHostile2 = BABYLON.MeshBuilder.CreateBox("boxHostile2", { size: 2.5 }, scene);
    boxHostile2.position.set(-4, 1.25, 5);
    boxHostile2.material = redMat;
    boxHostile2.metadata = {
        tag: "hostile",
        subtype: "shadow",
        attackPattern: "crush",
        damageZone: "torso",
        fearIntensity: 10,
        isAttacking: false,
        telegraphProgress: 0
    };
    new BABYLON.PhysicsAggregate(boxHostile2, BABYLON.PhysicsShapeType.BOX, { mass: 40, restitution: 0.1, friction: 0.9 }, scene);
    hostileAIs.push(new HostileCubeAI(boxHostile2, scene, null));

    // Коллизии hostile кубов с ragdoll-частями
    [boxHostile1, boxHostile2].forEach(hostileMesh => {
        if (hostileMesh.physicsBody) {
            hostileMesh.physicsBody.setCollisionCallbackEnabled(true);
            hostileMesh.physicsBody.getCollisionObservable().add((collisionEvent) => {
                const other = collisionEvent.collidedAgainst;
                if (other?.tag === "ragdollPart" && scene.reactionSystem) {
                    scene.reactionSystem.registerHit({
                        force: collisionEvent.impulse ?? 0,
                        point: collisionEvent.point,
                        normal: collisionEvent.normal || BABYLON.Vector3.Zero(),
                        bodyPart: other.transformNode?.name || 'unknown',
                        body: other
                    });
                }
            });
        }
    });

    // Убежище
    const sanctuaryStone = BABYLON.MeshBuilder.CreateCylinder("sanctuaryStone", { height: 0.4, diameter: 1.5 }, scene);
    sanctuaryStone.position.set(-5, 0.2, -5);
    sanctuaryStone.material = greenMat;
    sanctuaryStone.metadata = { tag: "sanctuary", comfortLevel: 0.8 };

    // Лёгкий куб (поднимаемый)
    const lightBox = BABYLON.MeshBuilder.CreateBox("lightBox", { size:0.6 }, scene);
    lightBox.position.set(2,0.3,6); lightBox.material = greenMat;
    lightBox.metadata = { tag: "dynamic" };
    const lightBoxAgg = new BABYLON.PhysicsAggregate(lightBox, BABYLON.PhysicsShapeType.BOX, { mass:1, restitution:0.5, friction:0.3 }, scene);
    lightBoxAgg.body.tag = "dynamic";

    // Средний динамический куб
    const boxDynamic = BABYLON.MeshBuilder.CreateBox("boxDynamic", { size:1.2 }, scene);
    boxDynamic.position.set(-2,0.6,3); boxDynamic.material = blueMat;
    boxDynamic.metadata = { tag: "dynamic" };
    const boxDynamicAgg = new BABYLON.PhysicsAggregate(boxDynamic, BABYLON.PhysicsShapeType.BOX, { mass:5, restitution:0.3, friction:0.6 }, scene);
    boxDynamicAgg.body.tag = "dynamic";

    // Шар
    const sphere = BABYLON.MeshBuilder.CreateSphere("sphere", { diameter:1.2 }, scene);
    sphere.position.set(0,1,4); sphere.material = greenMat;
    sphere.metadata = { tag: "dynamic" };
    const sphereAgg = new BABYLON.PhysicsAggregate(sphere, BABYLON.PhysicsShapeType.SPHERE, { mass:3, restitution:0.8, friction:0.2 }, scene);
    sphereAgg.body.tag = "dynamic";

    // Цилиндр
    const cylinder = BABYLON.MeshBuilder.CreateCylinder("cylinder", { height:1.8, diameter:1 }, scene);
    cylinder.position.set(4,0.9,-2); cylinder.material = yellowMat;
    cylinder.metadata = { tag: "dynamic" };
    const cylinderAgg = new BABYLON.PhysicsAggregate(cylinder, BABYLON.PhysicsShapeType.CYLINDER, { mass:4, restitution:0.3, friction:0.5 }, scene);
    cylinderAgg.body.tag = "dynamic";

    // Ступеньки (статика)
    const stepSmall = BABYLON.MeshBuilder.CreateBox("stepSmall", { width: 2, height: 0.1, depth: 1 }, scene);
    stepSmall.position.set(2, 0.05, 5); stepSmall.material = stepMat;
    stepSmall.metadata = { tag: "static" };
    new BABYLON.PhysicsAggregate(stepSmall, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene).body.tag = "static";

    const stepLarge = BABYLON.MeshBuilder.CreateBox("stepLarge", { width: 2, height: 0.3, depth: 1 }, scene);
    stepLarge.position.set(-2, 0.15, 5); stepLarge.material = stepMat;
    stepLarge.metadata = { tag: "static" };
    new BABYLON.PhysicsAggregate(stepLarge, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene).body.tag = "static";

    const stepIgnore = BABYLON.MeshBuilder.CreateBox("stepIgnore", { width: 2, height: 0.7, depth: 1 }, scene);
    stepIgnore.position.set(0, 0.35, 8); stepIgnore.material = stepMat;
    stepIgnore.metadata = { tag: "static" };
    new BABYLON.PhysicsAggregate(stepIgnore, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene).body.tag = "static";

    // Регистрация коллизий для динамических тел (не hostile)
    [boxDynamicAgg, sphereAgg, cylinderAgg, lightBoxAgg].forEach(agg => {
        if (agg?.body) {
            agg.body.setCollisionCallbackEnabled(true);
            agg.body.getCollisionObservable().add((collisionEvent) => {
                const otherBody = collisionEvent.collidedAgainst;
                if (otherBody?.tag === "ragdollPart" && scene.reactionSystem) {
                    scene.reactionSystem.registerHit({
                        force: collisionEvent.impulse ?? 0,
                        point: collisionEvent.point,
                        normal: collisionEvent.normal || BABYLON.Vector3.Zero(),
                        bodyPart: otherBody.transformNode?.name || 'unknown',
                        body: otherBody
                    });
                }
            });
        }
    });
}

function setupInput() {
    const inputMap = {};
    window.__inputMap = inputMap;
    scene.actionManager = new BABYLON.ActionManager(scene);
    scene.actionManager.registerAction(new BABYLON.ExecuteCodeAction(BABYLON.ActionManager.OnKeyDownTrigger, evt => {
        const key = evt.sourceEvent.key;
        inputMap[key] = true;
        if (key >= '1' && key <= '9') {
            if (window.gameplayMode === 2 && krl) {
                handleKrlTestPose(parseInt(key));
            } else {
                handleNumberKey(key);
            }
        }
        if (key === 'i' || key === 'I') cycleIdleAnimation();
        if (key === 'h' || key === 'H') toggleUI();
        if (key === 'r' || key === 'R') toggleRagdollMode();
        if (key === 'f' || key === 'F') {
            if (weaponSystem) {
                if (!weaponSystem.isActive) {
                    weaponSystem.setActive(true);
                    savedSensX = camera.angularSensibilityX;
                    savedSensY = camera.angularSensibilityY;
                    savedPanning = camera.panningSensibility;
                    camera.angularSensibilityX = Infinity;
                    camera.angularSensibilityY = Infinity;
                    camera.panningSensibility = 0;
                } else {
                    weaponSystem.setActive(false);
                    camera.angularSensibilityX = savedSensX;
                    camera.angularSensibilityY = savedSensY;
                    camera.panningSensibility = savedPanning;
                }
            }
        }
        if (key === 'e' || key === 'E') {
            if (scene.dim) scene.dim.toggleGrab();
        }
        if (key === 't' || key === 'T') {
            window.gameplayMode = window.gameplayMode === 1 ? 2 : 1;
            console.log(`Gameplay mode: ${window.gameplayMode}`);
        }
    }));
    scene.actionManager.registerAction(new BABYLON.ExecuteCodeAction(BABYLON.ActionManager.OnKeyUpTrigger, evt => {
        inputMap[evt.sourceEvent.key] = false;
    }));
}

function handleKrlTestPose(num) {
    if (!krl) return;
    switch (num) {
        case 1: krl.activatePose('block_head_r', 3); break;
        case 2: krl.activatePose('block_head_l', 3); break;
        case 3: // обе руки в защиту
            krl.activatePose('block_head_r', 3);
            krl.activatePose('block_torso_l', 3);
            break;
        case 4: krl.activatePose('point_fwd_r', 3); break;
        case 5: krl.activatePose('point_fwd_l', 3); break;
        case 6: krl.activatePose('touch_chest_l', 2); break;
        case 7: krl.activatePose('touch_head_r', 2); break;
        case 8: krl.deactivatePose(); break; // сброс
        case 9: krl.setLookTarget(new BABYLON.Vector3(-1, 0, 0)); break;
        case 0: // полный сброс
            krl.deactivatePose();
            krl.clearBoneTarget('pelvis');
            krl.clearBoneTarget('spine_03');
            krl.setLookTarget(null);
            break;
    }
}

function setupMouse() {
    window.__lastMouseX = 0;
    window.__lastMouseY = 0;
    scene.onPointerObservable.add((evt) => {
        if (evt.type === BABYLON.PointerEventTypes.POINTERDOWN) {
            if (evt.event.button === 0) {
                isLeftMouseDown = true;
                if (scene.dim && scene.dim.isGrabbing && scene.dim.grabMode === 'light' && !weaponSystem?.isActive) {
                    const groundPoint = window.getGroundPointUnderCursor();
                    if (groundPoint) {
                        scene.dim.throwObject(groundPoint);
                        evt.event.preventDefault();
                        isLeftMouseDown = false;
                        return;
                    }
                }
            } else if (evt.event.button === 2) {
                isRightMouseDown = true;
                evt.event.preventDefault();
            }
            window.__lastMouseX = evt.event.clientX;
            window.__lastMouseY = evt.event.clientY;
        } else if (evt.type === BABYLON.PointerEventTypes.POINTERUP) {
            if (evt.event.button === 0) isLeftMouseDown = false;
            else if (evt.event.button === 2) isRightMouseDown = false;
        } else if (evt.type === BABYLON.PointerEventTypes.POINTERMOVE) {
            const lastMouseX = window.__lastMouseX || evt.event.clientX;
            const lastMouseY = window.__lastMouseY || evt.event.clientY;
            mouseDeltaX = evt.event.clientX - lastMouseX;
            mouseDeltaY = evt.event.clientY - lastMouseY;
            mouseX = evt.event.clientX;
            mouseY = evt.event.clientY;
            if (weaponSystem && weaponSystem.isActive) {
                window.__mouseDelta = { x: mouseDeltaX, y: mouseDeltaY };
            }
            window.__lastMouseX = mouseX;
            window.__lastMouseY = mouseY;
        }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

const actionMap = {
    '1': 'Fighting Left Jab', '2': 'Fighting Right Jab', '3': 'Punch_Cross',
    '4': 'Melee_Hook', '5': 'OverhandThrow', '6': 'Hit_Chest',
    '7': 'Sword_Regular_C', '8': 'Throw Object', '9': 'Death01'
};

function handleNumberKey(key) {
    if (!animManager || !stateMachine || !stateMachine.currentState) return;
    const animName = actionMap[key];
    if (!animName || !animManager.upper[animName]) return;
    const moveState = movementSystem.getMovementState();
    const fullBody = !moveState.isMoving;
    if (stateMachine.currentState.name === STATE_NAMES.IDLE || stateMachine.currentState.name === STATE_NAMES.MOVE) {
        stateMachine.transitionTo(STATE_NAMES.ACTION, animName, fullBody);
    }
}

function cycleIdleAnimation() {
    if (!animManager || idleAnimations.length === 0) return;
    currentIdleIndex = (currentIdleIndex + 1) % idleAnimations.length;
    const newIdle = idleAnimations[currentIdleIndex];
    animManager.startUpperBase(newIdle);
    idleStatusDiv.innerHTML = `🧘 Текущая idle: ${newIdle}`;
}

function toggleRagdollMode() {
    if (!currentRagdoll || boneBodyMap.size === 0) return;
    if (stateMachine) {
        if (stateMachine.currentState.name !== STATE_NAMES.RAGDOLL && stateMachine.currentState.name !== STATE_NAMES.KNOCKDOWN) {
            stateMachine.transitionTo(STATE_NAMES.RAGDOLL, false);
        } else if (stateMachine.currentState.name === STATE_NAMES.RAGDOLL) {
            stateMachine.transitionTo(STATE_NAMES.GET_UP);
        }
    }
}

function toggleUI() {
    const controls = document.getElementById('controls');
    controls.classList.toggle('hidden');
    document.getElementById('hide-ui-btn').textContent = controls.classList.contains('hidden') ? '👁️ Показать UI' : '🙈 Скрыть UI';
}

let legIK = null;

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    statusDiv.innerHTML = `⏳ Загрузка ${file.name}...`;
    resetBtn.disabled = true;
    skeletonToggle.disabled = true;
    markerToggle.disabled = true;

    if (characterRoot) characterRoot.dispose();
    if (upperRoot) upperRoot.dispose();
    if (lowerRoot) lowerRoot.dispose();
    if (dynamicMesh) dynamicMesh.dispose();
    if (currentRagdoll) currentRagdoll.dispose?.();
    markers.forEach(m => m.dispose());
    upTargets = [];
    upperAnimGroups = {};
    lowerAnimGroups = {};
    if (weaponSystem) { weaponSystem.dispose(); weaponSystem = null; }
    if (legIK) { legIK.disable(); legIK = null; }
    if (scene.dim) { scene.dim.dispose(); scene.dim = null; }
    if (projectileSpawner) { projectileSpawner.dispose(); projectileSpawner = null; }
    if (krl) { krl.dispose(); krl = null; }
    if (perceptionSystem) { perceptionSystem.dispose(); perceptionSystem = null; }
    if (autonomousBehaviour) { autonomousBehaviour.dispose(); autonomousBehaviour = null; }

    try {
        const { mesh: meshU, skeleton: skelU, animationGroups: groupsU } = await loadModelOnce(file, scene);
        meshU.isVisible = false; meshU.name = "UpperMesh";
        const { mesh: meshL, skeleton: skelL, animationGroups: groupsL } = await loadModelOnce(file, scene);
        meshL.isVisible = false; meshL.name = "LowerMesh";

        meshUpper = meshU;
        meshLower = meshL;
        characterRoot = new BABYLON.TransformNode("characterRoot", scene);
        characterRoot.position.set(0, 0, 0);
        upperRoot = new BABYLON.TransformNode("upperRoot", scene);
        lowerRoot = new BABYLON.TransformNode("lowerRoot", scene);
        upperRoot.parent = characterRoot;
        lowerRoot.parent = characterRoot;

        meshUpper.setParent(upperRoot);
        meshLower.setParent(lowerRoot);
        meshUpper.setParent(characterRoot);
        centerAndScale(characterRoot, 1.8);
        characterRoot.position.y += 0.2;
        meshUpper.setParent(upperRoot);
        meshLower.setParent(lowerRoot);

        upperSkeleton = skelU;
        lowerSkeleton = skelL;
        groupsU.forEach(ag => upperAnimGroups[ag.name] = ag);
        groupsL.forEach(ag => lowerAnimGroups[ag.name] = ag);

        spineBoneUpper = findBone(upperSkeleton, "spine_02") || findBone(upperSkeleton, "spine02");
        spineBoneLower = findBone(lowerSkeleton, "spine_02") || findBone(lowerSkeleton, "spine02");

        const spineForSplit = spineBoneUpper || findBone(upperSkeleton, "hips") || upperSkeleton.bones[0];
        const { upper: upperNames, lower: lowerNames } = splitBoneNames(upperSkeleton, spineForSplit);

        const upperMarkers = createMarkers(upperSkeleton, upperRoot, upperNames, new BABYLON.Color3(0, 1, 0), scene);
        const lowerMarkers = createMarkers(lowerSkeleton, lowerRoot, lowerNames, new BABYLON.Color3(0, 0.5, 1), scene);
        markers = [...upperMarkers, ...lowerMarkers];

        const upperTargets = createUpTargets(upperSkeleton, upperRoot, scene);
        const lowerTargets = createUpTargets(lowerSkeleton, lowerRoot, scene);
        upTargets = [...upperTargets, ...lowerTargets];

        dynamicSkeleton = upperSkeleton.clone("dynamicSkeleton");
        dynamicMesh = meshUpper.clone("dynamicMesh", null);
        dynamicMesh.skeleton = dynamicSkeleton;
        dynamicMesh.isVisible = true;
        dynamicMesh.setParent(null);
        dynamicMesh.position.copyFrom(characterRoot.position);
        dynamicMesh.rotationQuaternion = characterRoot.rotationQuaternion ? characterRoot.rotationQuaternion.clone() : null;

        statusDiv.innerHTML = `🧮 Генерация конфига...`;
        const { configs } = buildRagdollConfig(dynamicSkeleton, dynamicMesh);
        statusDiv.innerHTML = `⚙️ Создание ragdoll...`;
        const ragdoll = new BABYLON.Ragdoll(dynamicSkeleton, dynamicMesh, configs);
        ragdoll.ragdoll();

        boneBodyMap.clear();
        if (ragdoll._bones && ragdoll._aggregates) {
            for (let i = 0; i < ragdoll._bones.length; i++) {
                const bone = ragdoll._bones[i];
                const aggregate = ragdoll._aggregates[i];
                if (bone && aggregate?.body) boneBodyMap.set(bone.name.trim(), aggregate.body);
            }
        }
        stabilizeBodies(boneBodyMap);
        createClavicleStabilizer(boneBodyMap, scene);
        currentRagdoll = ragdoll;

        // Построение иерархии костей для KRL
        const boneHierarchy = [];
        const boneLengths = {};
        for (const bone of dynamicSkeleton.bones) {
            const parentBone = bone.getParent();
            boneHierarchy.push({
                name: bone.name,
                parent: parentBone ? parentBone.name : null
            });
            const bName = bone.name.toLowerCase();
            if (bName.includes('upperarm')) boneLengths[bone.name] = 0.297;
            else if (bName.includes('lowerarm')) boneLengths[bone.name] = 0.28;
            else if (bName.includes('thigh')) boneLengths[bone.name] = 0.40;
            else if (bName.includes('calf')) boneLengths[bone.name] = 0.43;
            else boneLengths[bone.name] = 0.15;
        }

        // Создание KRL с передачей mesh и skeleton для IK
        krl = new KinematicRagdollLayer(scene, boneBodyMap, boneHierarchy, boneLengths, characterRoot, dynamicMesh, dynamicSkeleton);

        movementSystem = new MovementSystem(characterRoot, 0.9, 3.0, scene, scene);
        movementSystem.collisionCapsuleMesh = collisionCapsuleMesh;
        animManager = new AnimationManager(upperAnimGroups, lowerAnimGroups);

        stateMachine = new StateMachine();
        stateMachine.addState(new IdleState(STATE_NAMES.IDLE));
        stateMachine.addState(new MoveState(STATE_NAMES.MOVE));
        stateMachine.addState(new ActionState(STATE_NAMES.ACTION));
        stateMachine.addState(new ImpactState(STATE_NAMES.IMPACT));
        stateMachine.addState(new StruggleState(STATE_NAMES.STRUGGLE));
        stateMachine.addState(new KnockdownState(STATE_NAMES.KNOCKDOWN));
        stateMachine.addState(new GetUpState(STATE_NAMES.GET_UP));
        stateMachine.addState(new RagdollState(STATE_NAMES.RAGDOLL));
        stateMachine.addState(new DefendState(STATE_NAMES.DEFEND));
        stateMachine.addState(new StumbleState(STATE_NAMES.STUMBLE));
        stateMachine.addState(new RagdollImpactState(STATE_NAMES.RAGDOLL_IMPACT));

        stateMachine.animManager = animManager;
        stateMachine.movementSystem = movementSystem;
        stateMachine.dynamicMesh = dynamicMesh;
        stateMachine.boneBodyMap = boneBodyMap;
        stateMachine.pdStrength = 1.0;
        stateMachine.pdStrengthTarget = 1.0;
        stateMachine.staminaSystem = staminaSystem;
        stateMachine.camera = camera;

        for (let s of Object.values(stateMachine.states)) s.machine = stateMachine;

        // Системы второго этапа
        perceptionSystem = new PerceptionSystem(scene, characterRoot);
        autonomousBehaviour = new AutonomousBehaviour(
            scene, characterRoot, krl, perceptionSystem,
            staminaSystem, healthSystem, movementSystem,
            episodicMemory, perceivedCondition, trustModel
        );

        reactionSystem = new ReactionSystem(
            markers, boneBodyMap, upTargets, characterRoot, movementSystem,
            stateMachine, animManager, staminaSystem, autonomousBehaviour, healthSystem
        );
        stateMachine.reactionSystem = reactionSystem;
        scene.reactionSystem = reactionSystem;

        weaponSystem = new WeaponSystem(scene, upperSkeleton, meshUpper, upperRoot, { targetSphereRadius: 8.0, swordMass: 2.5 });
        weaponSystem.setBoneBodyMap(boneBodyMap);

        const collisionHandler = new CollisionResponseHandler(stateMachine, movementSystem, staminaSystem);
        movementSystem.collisionResponseHandler = collisionHandler;

        const legBones = {
            left: { thigh: findBone(lowerSkeleton, 'thigh_l'), calf: findBone(lowerSkeleton, 'calf_l'), foot: findBone(lowerSkeleton, 'foot_l') },
            right: { thigh: findBone(lowerSkeleton, 'thigh_r'), calf: findBone(lowerSkeleton, 'calf_r'), foot: findBone(lowerSkeleton, 'foot_r') }
        };
        legIK = new LegIK(scene, lowerRoot, lowerSkeleton, meshLower, legBones, 0);

        movementSystem.onLargeStep = (targetPoint, height, foot) => {
            animManager.setGlobalBlending(false);
            const animName = 'Zombie_Walk_Fwd_Loop';
            if (animManager.lower[animName] || animManager.upper[animName]) {
                animManager.startAction(animName, true, () => {
                    legIK.disable();
                    animManager.setForcedLower(null);
                    animManager.restoreBlending();
                }, { disableBlending: true });
            } else {
                setTimeout(() => { legIK.disable(); animManager.restoreBlending(); }, 600);
            }
            legIK.enableForStep(foot, targetPoint);
        };

        scene.dim = new DynamicInteractionManager(
            scene, camera, upperRoot, meshUpper, upperSkeleton, boneBodyMap,
            animManager, staminaSystem, movementSystem, weaponSystem, reactionSystem, stateMachine
        );

        // Обновляем characterRoot для hostile AIs
        hostileAIs.forEach(ai => ai.characterRoot = characterRoot);

        // Создаём ProjectileSpawner
        projectileSpawner = new ProjectileSpawner(scene, characterRoot, {
            spawnInterval: 2.5,
            projectileSpeed: 12,
            projectileMass: 2,
            projectileRadius: 0.3
        });

        const durSlider = document.getElementById('swing-duration');
        const durSpan = document.getElementById('swing-dur-val');
        const coolSlider = document.getElementById('swing-cooldown');
        const coolSpan = document.getElementById('swing-cool-val');
        const threshSlider = document.getElementById('swing-threshold');
        const threshSpan = document.getElementById('swing-thresh-val');
        const updateSwingParams = () => {
            if (weaponSystem) {
                weaponSystem.swingDuration = parseFloat(durSlider.value);
                weaponSystem.swingCooldown = parseFloat(coolSlider.value);
                weaponSystem.swingThresholdMin = parseFloat(threshSlider.value);
            }
            durSpan.textContent = durSlider.value;
            coolSpan.textContent = coolSlider.value;
            threshSpan.textContent = threshSlider.value;
        };
        durSlider.addEventListener('input', updateSwingParams);
        coolSlider.addEventListener('input', updateSwingParams);
        threshSlider.addEventListener('input', updateSwingParams);
        updateSwingParams();

        const lowSlider = document.getElementById('low-speed-threshold');
        const lowSpan = document.getElementById('low-speed-val');
        const mediumSlider = document.getElementById('medium-speed-threshold');
        const mediumSpan = document.getElementById('medium-speed-val');
        lowSlider.addEventListener('input', () => {
            movementSystem.lowSpeedThreshold = parseFloat(lowSlider.value);
            lowSpan.textContent = lowSlider.value;
        });
        mediumSlider.addEventListener('input', () => {
            movementSystem.mediumSpeedThreshold = parseFloat(mediumSlider.value);
            mediumSpan.textContent = mediumSlider.value;
        });

        const loopingKeywords = ['idle', 'walk', 'jog', 'sprint', 'crouch', 'tired', 'zombie', 'formal', 'run'];
        idleAnimations = Object.keys(upperAnimGroups).filter(name =>
            loopingKeywords.some(keyword => name.toLowerCase().includes(keyword))
        );
        if (idleAnimations.length === 0 && Object.keys(upperAnimGroups).length > 0) idleAnimations = [Object.keys(upperAnimGroups)[0]];
        currentIdleIndex = 0;

        stateMachine.start(STATE_NAMES.IDLE);
        if (idleAnimations.length > 0) idleStatusDiv.innerHTML = `🧘 Текущая idle: ${idleAnimations[0]}`;

        const moveState = movementSystem.getMovementState();
        const desiredLower = animManager.getDesiredLowerFromMovement(moveState, 0);
        animManager.setBaseAnimations(null, desiredLower);

        resetBtn.disabled = false;
        skeletonToggle.disabled = false;
        markerToggle.disabled = false;
        statusDiv.innerHTML = `✅ УСПЕШНО! Костей: ${upperSkeleton.bones.length}, анимаций: верх: ${Object.keys(upperAnimGroups).length}, низ: ${Object.keys(lowerAnimGroups).length}`;
    } catch (err) {
        console.error(err);
        statusDiv.innerHTML = `❌ Ошибка: ${err.message}`;
    }
});

resetBtn.addEventListener('click', () => {
    if (!characterRoot || !currentRagdoll || !movementSystem || !animManager) return;
    if (stateMachine) stateMachine.transitionTo(STATE_NAMES.IDLE);
    movementSystem.reset();
    animManager.resetActions();
    dynamicMesh.position.copyFrom(characterRoot.position);
    dynamicMesh.rotationQuaternion = characterRoot.rotationQuaternion ? characterRoot.rotationQuaternion.clone() : null;
    currentRagdoll.ragdoll();
    stabilizeBodies(boneBodyMap);
    if (legIK) legIK.disable();
    if (scene.dim) scene.dim._reset();
    healthSystem.currentHealth = healthSystem.maxHealth;
    staminaSystem.currentStamina = staminaSystem.maxStamina;
    perceivedCondition.perceivedHealth = healthSystem.maxHealth;
    perceivedCondition.perceivedStamina = staminaSystem.maxStamina;
    episodicMemory.events = [];
    trustModel.trust = 0.6;
    if (autonomousBehaviour) autonomousBehaviour.fearLevel = 0;
    statusDiv.innerHTML = `🔄 Сброс позиции`;
});

skeletonToggle.addEventListener('click', () => {
    if (!dynamicMesh || !dynamicSkeleton) return;
    if (window.skeletonViewer) {
        window.skeletonViewer.dispose();
        window.skeletonViewer = null;
        skeletonToggle.textContent = '👁️ Скелет (динамика)';
    } else {
        window.skeletonViewer = new BABYLON.Debug.SkeletonViewer(dynamicSkeleton, dynamicMesh, scene, false, 2, { color: new BABYLON.Color3(0.3, 0.8, 1.0) });
        skeletonToggle.textContent = '👁️ Скрыть скелет (динамика)';
    }
});

markerToggle.addEventListener('click', () => {
    markersVisible = !markersVisible;
    markers.forEach(m => m.isVisible = markersVisible);
    markerToggle.textContent = markersVisible ? '🔘 Скрыть маркеры' : '🔘 Показать маркеры';
});

document.getElementById('test-impulse-btn').addEventListener('click', () => {
    if (!boneBodyMap.size) return;
    const force = 10 + Math.random() * 90;
    document.getElementById('test-force').innerHTML = `Сила: ${force.toFixed(1)}`;
    let targetBody = null;
    for (let [name, body] of boneBodyMap.entries()) {
        if (name.toLowerCase().includes('pelvis')) { targetBody = body; break; }
    }
    if (!targetBody) targetBody = boneBodyMap.values().next().value;
    if (!targetBody) return;
    const cameraDir = camera.getDirection(new BABYLON.Vector3(0,0,1));
    const impulseDir = cameraDir.add(new BABYLON.Vector3(0,0.3,0)).normalize();
    const worldPos = targetBody.transformNode.getAbsolutePosition();
    targetBody.applyImpulse(impulseDir.scale(force), worldPos);
    if (reactionSystem) {
        reactionSystem.registerHit({ force, point: worldPos, normal: impulseDir, bodyPart: 'pelvis', body: targetBody });
    }
    statusDiv.innerHTML = `💥 Тестовый импульс ${force.toFixed(1)}`;
});

document.getElementById('stand-up-btn').addEventListener('click', () => {
    if (stateMachine && (stateMachine.currentState.name === STATE_NAMES.RAGDOLL || stateMachine.currentState.name === STATE_NAMES.KNOCKDOWN)) {
        stateMachine.transitionTo(STATE_NAMES.GET_UP);
    }
});

document.getElementById('ragdoll-btn').addEventListener('click', toggleRagdollMode);
document.getElementById('hide-ui-btn').addEventListener('click', toggleUI);

initScene();