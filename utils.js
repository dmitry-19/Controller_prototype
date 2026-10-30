// js/utils.js
export async function loadModelOnce(file, scene) {
    const blob = new Blob([file], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
        const result = await BABYLON.SceneLoader.ImportMeshAsync("", url, "", scene, null, ".glb");
        const mesh = result.meshes.find(m => m.skeleton);
        if (!mesh) throw new Error("Нет скелета");
        if (mesh.parent && mesh.parent.name.includes('__root__')) {
            mesh.setParent(null);
        }
        return { mesh, skeleton: mesh.skeleton, animationGroups: scene.animationGroups.slice() };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function centerAndScale(root, targetHeight = 1.8) {
    const meshes = root.getChildMeshes ? root.getChildMeshes(true) : [root];
    let min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
    let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
    meshes.forEach(m => {
        if (m.getBoundingInfo) {
            const bi = m.getBoundingInfo();
            min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
            max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
        }
    });
    const center = BABYLON.Vector3.Center(min, max);
    const size = max.subtract(min);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0.001) {
        const scale = targetHeight / maxDim;
        root.scaling.scaleInPlace(scale);
        root.position.subtractInPlace(center.multiplyByFloats(scale, scale, scale));
        root.position.y += targetHeight * 0.5;
    }
}

export function findBone(skeleton, namePart) {
    return skeleton.bones.find(b => b.name.toLowerCase().includes(namePart.toLowerCase()));
}

export function getAllDescendantBones(rootBone) {
    const result = [rootBone];
    rootBone.children.forEach(child => {
        result.push(...getAllDescendantBones(child));
    });
    return result;
}

export function splitBoneNames(skeleton, spineBone) {
    if (!spineBone) {
        const mid = Math.floor(skeleton.bones.length / 2);
        return {
            upper: skeleton.bones.slice(0, mid).map(b => b.name),
            lower: skeleton.bones.slice(mid).map(b => b.name)
        };
    }
    const upperBonesSet = new Set(getAllDescendantBones(spineBone).map(b => b.name));
    const upper = skeleton.bones.filter(b => upperBonesSet.has(b.name)).map(b => b.name);
    const lower = skeleton.bones.filter(b => !upperBonesSet.has(b.name)).map(b => b.name);
    return { upper, lower };
}

export function createMarkers(skeleton, rootNode, boneNames, color, scene) {
    const markers = [];
    boneNames.forEach(name => {
        const bone = skeleton.bones.find(b => b.name === name);
        if (!bone) return;
        const sphere = BABYLON.MeshBuilder.CreateSphere("marker_" + name, { diameter: 0.12 }, scene);
        sphere.material = new BABYLON.StandardMaterial("markerMat", scene);
        sphere.material.emissiveColor = color;
        sphere.material.disableLighting = true;
        sphere.attachToBone(bone, rootNode);
        markers.push(sphere);
    });
    return markers;
}

export function createUpTargets(skeleton, rootNode, scene) {
    const targets = [];
    const headBone = skeleton.bones.find(b => b.name.toLowerCase().includes('head'));
    if (headBone) {
        const target = new BABYLON.TransformNode("upHead", scene);
        target.attachToBone(headBone, rootNode);
        target.position.set(0, 0.3, 0);
        targets.push({ bone: headBone, targetNode: target, stiffness: 40 });
    }
    ['clavicle_l', 'clavicle_r'].forEach(side => {
        const bone = skeleton.bones.find(b => b.name.toLowerCase().includes(side));
        if (bone) {
            const target = new BABYLON.TransformNode(`up${side}`, scene);
            target.attachToBone(bone, rootNode);
            target.position.set(0, 0.15, 0.1);
            targets.push({ bone, targetNode: target, stiffness: 25 });
        }
    });
    ['spine_03', 'spine_02'].forEach((name, i) => {
        const bone = skeleton.bones.find(b => b.name.toLowerCase().includes(name));
        if (bone) {
            const target = new BABYLON.TransformNode(`up${name}`, scene);
            target.attachToBone(bone, rootNode);
            target.position.set(0, 0.2 - i * 0.05, 0.05);
            targets.push({ bone, targetNode: target, stiffness: 30 - i * 5 });
        }
    });
    return targets;
}

export function createCollisionCapsule(rootNode, scene) {
    const capsuleNode = new BABYLON.TransformNode("collisionCapsule", scene);
    const capsuleMesh = BABYLON.MeshBuilder.CreateCylinder("capsuleVis", { height: 3.0, diameter: 1.8 }, scene);
    capsuleMesh.parent = capsuleNode;
    capsuleMesh.position.y = 1.5;
    const mat = new BABYLON.StandardMaterial("capsuleMat", scene);
    mat.alpha = 0.4;
    mat.diffuseColor = new BABYLON.Color3(0, 0.8, 1);
    capsuleMesh.material = mat;
    capsuleMesh.isVisible = true;
    return { node: capsuleNode, mesh: capsuleMesh };
}