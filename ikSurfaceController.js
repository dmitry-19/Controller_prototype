// js/ikSurfaceController.js
export class IKSurfaceController {
    constructor(scene, upperRoot, meshUpper, upperSkeleton) {
        this.scene = scene;
        this.upperRoot = upperRoot;
        this.mesh = meshUpper;
        this.skeleton = upperSkeleton;

        // Начальные точки (можно загрузить из JSON позже)
        this.points = [
            { id: "p0", name: "toleft",  rightHand: {x:0, y:1.07, z:0.205}, gripOffset:{x:0.225, y:0.005, z:0.01}, leftBendAxis:"0,0,1", rightBendAxis:"-1,0,0", leftPoleAngle:0.4, rightPoleAngle:0.25 },
            { id: "p1", name: "down",    rightHand: {x:-0.275, y:0.84, z:0.12}, gripOffset:{x:-0.03, y:-0.13, z:0.19}, leftBendAxis:"0,0,-1", rightBendAxis:"0,0,1", leftPoleAngle:3.15, rightPoleAngle:0 },
            { id: "p2", name: "toright", rightHand: {x:-0.355, y:1.235, z:-0.1}, gripOffset:{x:0.185, y:0.07, z:-0.025}, leftBendAxis:"1,0,0", rightBendAxis:"0,0,1", leftPoleAngle:0, rightPoleAngle:0 },
            { id: "p3", name: "neutral", rightHand: {x:-0.23322, y:0.96, z:0.19372}, gripOffset:{x:-0.08, y:0.14, z:0.1}, leftBendAxis:"0,0,1", rightBendAxis:"0,0,1", leftPoleAngle:0, rightPoleAngle:0 },
            { id: "p4", name: "up",      rightHand: {x:-0.12, y:1.65, z:0.165}, gripOffset:{x:0.08, y:0.085, z:-0.1}, leftBendAxis:"1,0,0", rightBendAxis:"0,0,1", leftPoleAngle:1.55, rightPoleAngle:5.3 }
        ];

        // Настройки поверхности
        this.surfaceScale = 1.15;
        this.surfaceOffsetY = -0.05;
        this.attractionPower = 4.0;

        // IK контроллеры и цели
        this.ikControllers = { left: null, right: null };
        this.targets = { leftHand: null, rightHand: null };
        this.bones = { leftLowerArm: null, rightLowerArm: null };

        // Текущие интерполированные параметры
        this.currentGripOffset = new BABYLON.Vector3(0,0,0);
        this.currentLeftPoleAngle = 0;
        this.currentRightPoleAngle = 0;
        this.currentLeftBendAxis = new BABYLON.Vector3(0,0,1);
        this.currentRightBendAxis = new BABYLON.Vector3(0,0,1);

        // Позиции маркера
        this.currentMarkerLocalPos = new BABYLON.Vector3(-0.23322, 0.96, 0.19372);
        this.desiredMarkerLocalPos = this.currentMarkerLocalPos.clone();

        // Визуальные элементы
        this.mouseMarker = null;
        this.controlSurface = null;
        this.visualSurface = null;

        // Режим редактора
        this.editMode = false;
        this.selectedPointId = null;

        this.init();
    }

    init() {
        this.findBones();
        this.createTargets();
        this.createControlSurface();
        this.createMarker();
        this.setupIK();

        // Установить начальную позицию
        const neutral = this.points.find(p => p.name === "neutral") || this.points[0];
        this.currentMarkerLocalPos.set(neutral.rightHand.x, neutral.rightHand.y, neutral.rightHand.z);
        this.desiredMarkerLocalPos.copyFrom(this.currentMarkerLocalPos);
        this.updateInterpolation(this.currentMarkerLocalPos);
    }

    findBones() {
        const find = (patterns) => {
            for (let bone of this.skeleton.bones) {
                const name = bone.name.toLowerCase();
                if (patterns.some(p => name.includes(p.toLowerCase()))) return bone;
            }
            return null;
        };
        this.bones.leftLowerArm = find(["leftlowerarm","lowerarm_l","forearm_l","mixamorig:leftforearm","left_forearm"]);
        this.bones.rightLowerArm = find(["rightlowerarm","lowerarm_r","forearm_r","mixamorig:rightforearm","right_forearm"]);
    }

    createTargets() {
        this.targets.leftHand = new BABYLON.TransformNode("target_left", this.scene);
        this.targets.rightHand = new BABYLON.TransformNode("target_right", this.scene);
        this.targets.leftHand.parent = this.upperRoot;
        this.targets.rightHand.parent = this.upperRoot;

        // Визуальные сферы
        const greenMat = new BABYLON.StandardMaterial("green", this.scene);
        greenMat.emissiveColor = new BABYLON.Color3(0,0.9,0);
        const leftSphere = BABYLON.MeshBuilder.CreateSphere("vis_left", {diameter:0.1}, this.scene);
        leftSphere.material = greenMat;
        leftSphere.parent = this.targets.leftHand;

        const yellowMat = new BABYLON.StandardMaterial("yellow", this.scene);
        yellowMat.emissiveColor = new BABYLON.Color3(1,0.8,0);
        const rightSphere = BABYLON.MeshBuilder.CreateSphere("vis_right", {diameter:0.1}, this.scene);
        rightSphere.material = yellowMat;
        rightSphere.parent = this.targets.rightHand;
    }

    createControlSurface() {
        if (this.controlSurface) this.controlSurface.dispose();
        if (this.visualSurface) this.visualSurface.dispose();
        if (this.points.length < 3) return;

        const pointPositions = this.points.map(p => new BABYLON.Vector3(p.rightHand.x, p.rightHand.y, p.rightHand.z));
        const center = new BABYLON.Vector3(0,0,0);
        pointPositions.forEach(p => center.addInPlace(p));
        center.scaleInPlace(1/pointPositions.length);

        const scaledPoints = pointPositions.map(pos => {
            const dir = pos.subtract(center);
            const scaledDir = new BABYLON.Vector3(dir.x * this.surfaceScale, dir.y, dir.z * this.surfaceScale);
            return center.add(scaledDir).add(new BABYLON.Vector3(0, this.surfaceOffsetY, 0));
        });

        // Триангуляция веером
        const indices = [];
        for (let i = 1; i < scaledPoints.length - 1; i++) {
            indices.push(0, i, i+1);
        }
        if (scaledPoints.length > 2) indices.push(0, scaledPoints.length-1, 1);

        const surfaceMesh = new BABYLON.Mesh("controlSurface", this.scene);
        const vertexData = new BABYLON.VertexData();
        vertexData.positions = scaledPoints.flatMap(v => [v.x, v.y, v.z]);
        vertexData.indices = indices;
        vertexData.applyToMesh(surfaceMesh);
        surfaceMesh.parent = this.upperRoot;
        surfaceMesh.isPickable = true;

        const visualMesh = surfaceMesh.clone("visualSurface");
        const mat = new BABYLON.StandardMaterial("surfaceMat", this.scene);
        mat.diffuseColor = new BABYLON.Color3(0.3, 0.6, 0.9);
        mat.alpha = 0.28;
        mat.backFaceCulling = false;
        visualMesh.material = mat;
        visualMesh.isPickable = false;

        this.controlSurface = surfaceMesh;
        this.visualSurface = visualMesh;
    }

    createMarker() {
        const markerMat = new BABYLON.StandardMaterial("markerMat", this.scene);
        markerMat.emissiveColor = new BABYLON.Color3(1, 0.8, 0);
        this.mouseMarker = BABYLON.MeshBuilder.CreateSphere("marker", {diameter: 0.12}, this.scene);
        this.mouseMarker.material = markerMat;
    }

    setupIK() {
        // Удаляем старые контроллеры
        if (this.ikControllers.left) { try { this.ikControllers.left.dispose(); } catch(e) {} }
        if (this.ikControllers.right) { try { this.ikControllers.right.dispose(); } catch(e) {} }

        const leftPole = new BABYLON.TransformNode("pole_left", this.scene);
        const rightPole = new BABYLON.TransformNode("pole_right", this.scene);
        leftPole.parent = this.upperRoot;
        rightPole.parent = this.upperRoot;
        leftPole.position.set(0.45, -0.15, -0.55);
        rightPole.position.set(-0.45, -0.15, -0.55);

        if (this.bones.leftLowerArm && this.targets.leftHand) {
            this.ikControllers.left = new BABYLON.BoneIKController(this.mesh, this.bones.leftLowerArm, {
                targetMesh: this.targets.leftHand,
                poleTargetMesh: leftPole,
                poleAngle: this.currentLeftPoleAngle,
                bendAxis: this.currentLeftBendAxis,
                slerpAmount: 0.85
            });
        }
        if (this.bones.rightLowerArm && this.targets.rightHand) {
            this.ikControllers.right = new BABYLON.BoneIKController(this.mesh, this.bones.rightLowerArm, {
                targetMesh: this.targets.rightHand,
                poleTargetMesh: rightPole,
                poleAngle: this.currentRightPoleAngle,
                bendAxis: this.currentRightBendAxis,
                slerpAmount: 0.85
            });
        }
    }

    // Вычисление весов и интерполяция параметров
    updateInterpolation(markerLocalPos) {
        if (this.points.length === 0) return;

        const distances = this.points.map(p => {
            const dx = markerLocalPos.x - p.rightHand.x;
            const dy = markerLocalPos.y - p.rightHand.y;
            const dz = markerLocalPos.z - p.rightHand.z;
            return Math.sqrt(dx*dx + dy*dy + dz*dz);
        });

        // Находим ближайшую точку
        let nearestIdx = 0;
        let nearestDist = distances[0];
        for (let i=1; i<distances.length; i++) {
            if (distances[i] < nearestDist) {
                nearestDist = distances[i];
                nearestIdx = i;
            }
        }

        const threshold = 0.05;
        let weights;
        if (nearestDist < threshold) {
            weights = this.points.map((_, i) => i === nearestIdx ? 1 : 0);
        } else {
            const eps = 0.001;
            const rawWeights = distances.map(d => 1.0 / (Math.pow(d, this.attractionPower) + eps));
            const sum = rawWeights.reduce((a,b)=>a+b, 0);
            weights = rawWeights.map(w => w / sum);
        }

        // Интерполяция параметров
        let gripX=0, gripY=0, gripZ=0;
        let leftPole=0, rightPole=0;
        for (let i=0; i<this.points.length; i++) {
            const w = weights[i];
            const p = this.points[i];
            gripX += w * p.gripOffset.x;
            gripY += w * p.gripOffset.y;
            gripZ += w * p.gripOffset.z;
            leftPole += w * p.leftPoleAngle;
            rightPole += w * p.rightPoleAngle;
        }
        this.currentGripOffset.set(gripX, gripY, gripZ);
        this.currentLeftPoleAngle = leftPole;
        this.currentRightPoleAngle = rightPole;

        // Bend axes берём от доминирующей точки
        let maxIdx = 0;
        for (let i=1; i<weights.length; i++) if (weights[i] > weights[maxIdx]) maxIdx = i;
        const dom = this.points[maxIdx];
        const la = dom.leftBendAxis.split(',').map(Number);
        const ra = dom.rightBendAxis.split(',').map(Number);
        this.currentLeftBendAxis = new BABYLON.Vector3(la[0], la[1], la[2]);
        this.currentRightBendAxis = new BABYLON.Vector3(ra[0], ra[1], ra[2]);

        this.desiredMarkerLocalPos.copyFrom(markerLocalPos);
        this.setupIK(); // пересоздаём с новыми углами и осями

        // Обновляем UI весов (если есть элемент)
        const weightsDisplay = document.getElementById('ik-weights-display');
        if (weightsDisplay) {
            const text = this.points.map((p,i) => `${p.name}: ${(weights[i]*100).toFixed(1)}%`).join(' | ');
            weightsDisplay.innerHTML = `Вес поз: ${text}`;
        }
    }

    // Плавное движение целей
    updateSmoothPositions(deltaTime) {
        const speed = 9.0;
        BABYLON.Vector3.SmoothToRef(this.currentMarkerLocalPos, this.desiredMarkerLocalPos, speed, deltaTime, this.currentMarkerLocalPos);

        this.targets.rightHand.position.copyFrom(this.currentMarkerLocalPos);
        this.targets.leftHand.position.copyFrom(this.currentMarkerLocalPos);
        this.targets.leftHand.position.x += this.currentGripOffset.x;
        this.targets.leftHand.position.y += this.currentGripOffset.y;
        this.targets.leftHand.position.z += this.currentGripOffset.z;

        if (this.mouseMarker) {
            const worldPos = this.upperRoot.getAbsolutePosition().add(this.currentMarkerLocalPos);
            this.mouseMarker.position.copyFrom(worldPos);
        }

        if (this.ikControllers.right) this.ikControllers.right.update();
        if (this.ikControllers.left) this.ikControllers.left.update();
    }

    // Обработка движения мыши
    onMouseMove(e, canvas, camera) {
        if (!this.controlSurface) return;

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const ray = this.scene.createPickingRay(mouseX, mouseY, BABYLON.Matrix.Identity(), camera);
        let pickInfo = this.scene.pickWithRay(ray, (mesh) => mesh === this.controlSurface);
        let worldPoint = null;

        if (pickInfo && pickInfo.pickedPoint) {
            worldPoint = pickInfo.pickedPoint;
        } else {
            worldPoint = this.getClosestPointOnSurface(ray);
        }

        if (worldPoint) {
            const localPoint = worldPoint.subtract(this.upperRoot.getAbsolutePosition());
            if (this.editMode && this.selectedPointId) {
                const pt = this.points.find(p => p.id === this.selectedPointId);
                if (pt) {
                    pt.rightHand = { x: localPoint.x, y: localPoint.y, z: localPoint.z };
                    this.createControlSurface();
                    this.updateInterpolation(localPoint);
                    this.refreshUI();
                }
            } else {
                this.updateInterpolation(localPoint);
            }
        }
    }

    getClosestPointOnSurface(ray) {
        if (!this.controlSurface) return null;
        const positions = this.controlSurface.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        const indicesArr = this.controlSurface.getIndices();
        if (!positions || !indicesArr) return null;

        let closestDist = Infinity;
        let closestPoint = null;

        for (let i = 0; i < indicesArr.length; i += 3) {
            const i1 = indicesArr[i];
            const i2 = indicesArr[i+1];
            const i3 = indicesArr[i+2];
            const p1 = new BABYLON.Vector3(positions[i1*3], positions[i1*3+1], positions[i1*3+2]);
            const p2 = new BABYLON.Vector3(positions[i2*3], positions[i2*3+1], positions[i2*3+2]);
            const p3 = new BABYLON.Vector3(positions[i3*3], positions[i3*3+1], positions[i3*3+2]);

            const worldMat = this.controlSurface.getWorldMatrix();
            const wp1 = BABYLON.Vector3.TransformCoordinates(p1, worldMat);
            const wp2 = BABYLON.Vector3.TransformCoordinates(p2, worldMat);
            const wp3 = BABYLON.Vector3.TransformCoordinates(p3, worldMat);

            const closest = BABYLON.Ray.GetClosestPointToTriangle(ray, wp1, wp2, wp3);
            if (closest) {
                const dist = BABYLON.Vector3.Distance(closest, ray.origin);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestPoint = closest;
                }
            }
        }
        return closestPoint;
    }

    // Методы для UI (будут вызваны извне)
    setEditMode(enabled) {
        this.editMode = enabled;
        if (!enabled) this.selectedPointId = null;
        this.refreshUI();
    }

    addPoint() {
        const newId = 'p'+Date.now();
        const newName = `point_${this.points.length+1}`;
        this.points.push({
            id: newId, name: newName,
            rightHand: { x: this.currentMarkerLocalPos.x, y: this.currentMarkerLocalPos.y, z: this.currentMarkerLocalPos.z },
            gripOffset: { x: 0, y: 0, z: 0.15 },
            leftBendAxis: "0,0,1", rightBendAxis: "0,0,1",
            leftPoleAngle: 0, rightPoleAngle: 0
        });
        this.selectedPointId = newId;
        this.createControlSurface();
        this.refreshUI();
    }

    exportPoints() {
        const data = {
            surfaceScale: this.surfaceScale,
            surfaceOffsetY: this.surfaceOffsetY,
            attractionPower: this.attractionPower,
            points: this.points.map(p => ({
                name: p.name,
                rightHand: p.rightHand,
                gripOffset: p.gripOffset,
                leftBendAxis: p.leftBendAxis,
                rightBendAxis: p.rightBendAxis,
                leftPoleAngle: p.leftPoleAngle,
                rightPoleAngle: p.rightPoleAngle
            }))
        };
        return JSON.stringify(data, null, 2);
    }

    importPoints(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            if (data.surfaceScale !== undefined) this.surfaceScale = data.surfaceScale;
            if (data.surfaceOffsetY !== undefined) this.surfaceOffsetY = data.surfaceOffsetY;
            if (data.attractionPower !== undefined) this.attractionPower = data.attractionPower;
            if (data.points && data.points.length) {
                this.points = data.points.map((pt, idx) => ({ id: `p${idx}`, ...pt }));
                this.selectedPointId = this.points[0]?.id || null;
                this.createControlSurface();
                this.updateInterpolation(this.currentMarkerLocalPos);
                this.refreshUI();
            }
            this.updateSliders();
        } catch(e) {
            console.error('Import failed', e);
        }
    }

    // Обновление UI (должно быть реализовано в основном файле)
    refreshUI() {}
    updateSliders() {}

    // Основной метод обновления, вызывается каждый кадр
    update(deltaTime) {
        if (!this.upperRoot) return;
        this.updateSmoothPositions(deltaTime);
    }

    dispose() {
        if (this.controlSurface) this.controlSurface.dispose();
        if (this.visualSurface) this.visualSurface.dispose();
        if (this.mouseMarker) this.mouseMarker.dispose();
        if (this.targets.leftHand) this.targets.leftHand.dispose();
        if (this.targets.rightHand) this.targets.rightHand.dispose();
        // IK контроллеры не имеют dispose, но можно обнулить
    }
}