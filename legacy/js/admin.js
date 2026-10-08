class AdminManager {
    constructor() {
        this.isActive = false;
        this.currentNode = null;
        this.nodes = [];
        this.token = null;
        this.currentTab = 'nodes';
        this.uploadedImages = {};
        this.autoCreateMode = true;
        this.pendingDirection = null;
        this.init();
    }

    async init() {
        this.token = new URLSearchParams(window.location.search).get('token');
        await this.loadNodes();
        this.setupEventListeners();
    }

    async loadNodes() {
        try {
            const response = await fetch('/api/nodes', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            
            if (response.ok) {
                this.nodes = await response.json();
                this.populateNodeList();
            } else {
                console.error('Error loading nodes:', response.status);
            }
        } catch (error) {
            console.error('Error loading nodes:', error);
        }
    }

    setupEventListeners() {
        const adminBtn = document.getElementById('admin-btn');
        if (adminBtn) {
            adminBtn.addEventListener('click', () => this.toggle());
        }
    }

    toggle() {
        this.isActive = !this.isActive;
        
        const adminPanel = document.getElementById('admin-builder');
        const viewer3d = document.getElementById('viewer-3d');
        const viewer2d = document.getElementById('viewer-2d');
        
        if (this.isActive) {
            adminPanel.classList.remove('hidden');
            viewer3d.classList.remove('active');
            viewer2d.classList.remove('active');
            this.loadAdminInterface();
        } else {
            adminPanel.classList.add('hidden');
            viewer3d.classList.add('active');
        }
    }

    loadAdminInterface() {
        const adminPanel = document.getElementById('admin-builder');
        adminPanel.innerHTML = `
            <div class="admin-header">
                <h2>🏛️ Campus Navigation Admin - Smart Builder</h2>
                <p>Build navigation flow by uploading images and automatically creating linked nodes</p>
            </div>
            
            <div class="admin-tabs">
                <button class="admin-tab active" onclick="adminManager.showTab('nodes')">
                    📍 Node Management
                </button>
                <button class="admin-tab" onclick="adminManager.showTab('images')">
                    🖼️ Smart Image Builder
                </button>
                <button class="admin-tab" onclick="adminManager.showTab('map')">
                    🗺️ Map Editor
                </button>
                <button class="admin-tab" onclick="adminManager.showTab('preview')">
                    👁️ Navigation Preview
                </button>
            </div>
            
            <div class="admin-content" id="admin-content">
                ${this.renderNodesTab()}
            </div>
        `;
        
        this.setupAdminEventListeners();
    }

    renderNodesTab() {
        return `
            <div class="admin-panel-content">
                <div class="node-management">
                    <div class="node-form-section">
                        <h3>${this.currentNode ? 'Edit Node' : 'Create New Node'}</h3>
                        <form id="node-form" class="node-form">
                            <div class="form-row">
                                <div class="form-group">
                                    <label>Node ID:</label>
                                    <input type="text" id="node-id" required 
                                           placeholder="e.g., main-gate-001">
                                </div>
                                <div class="form-group">
                                    <label>Title:</label>
                                    <input type="text" id="node-title" required 
                                           placeholder="e.g., Main Entrance">
                                </div>
                            </div>
                            
                            <div class="form-row">
                                <div class="form-group">
                                    <label>Map Position:</label>
                                    <div class="position-inputs">
                                        <input type="number" id="node-pos-x" placeholder="X" min="0" max="600">
                                        <input type="number" id="node-pos-y" placeholder="Y" min="0" max="400">
                                    </div>
                                </div>
                                <div class="form-group">
                                    <label>Floor Level:</label>
                                    <select id="node-floor">
                                        <option value="0">Ground Floor</option>
                                        <option value="1">First Floor</option>
                                        <option value="2">Second Floor</option>
                                        <option value="3">Third Floor</option>
                                        <option value="-1">Basement</option>
                                    </select>
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label>Building/Area:</label>
                                <input type="text" id="node-building" 
                                       placeholder="e.g., Administration Building">
                            </div>
                            
                            <div class="form-group">
                                <label>Description/Notes:</label>
                                <textarea id="node-notes" rows="3" 
                                          placeholder="Additional information about this location"></textarea>
                            </div>
                            
                            <h4>🔗 Navigation Links</h4>
                            <div class="links-grid">
                                <div class="link-group">
                                    <label>Front →</label>
                                    <select id="link-front">
                                        <option value="">-- No Link --</option>
                                        ${this.nodes.map(node => 
                                            `<option value="${node.id}">${node.title}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <div class="link-group">
                                    <label>Back ←</label>
                                    <select id="link-back">
                                        <option value="">-- No Link --</option>
                                        ${this.nodes.map(node => 
                                            `<option value="${node.id}">${node.title}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <div class="link-group">
                                    <label>Left ↰</label>
                                    <select id="link-left">
                                        <option value="">-- No Link --</option>
                                        ${this.nodes.map(node => 
                                            `<option value="${node.id}">${node.title}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <div class="link-group">
                                    <label>Right ↱</label>
                                    <select id="link-right">
                                        <option value="">-- No Link --</option>
                                        ${this.nodes.map(node => 
                                            `<option value="${node.id}">${node.title}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                            </div>
                            
                            <div class="form-actions">
                                <button type="submit" class="btn-primary">
                                    💾 ${this.currentNode ? 'Update Node' : 'Create Node'}
                                </button>
                                <button type="button" onclick="adminManager.newNode()" class="btn-secondary">
                                    🆕 New Node
                                </button>
                                ${this.currentNode ? `
                                    <button type="button" onclick="adminManager.deleteNode()" class="btn-danger">
                                        🗑️ Delete Node
                                    </button>
                                ` : ''}
                            </div>
                        </form>
                    </div>
                    
                    <div class="node-list-section">
                        <h3>📋 Existing Nodes (${this.nodes.length})</h3>
                        <div class="node-list" id="node-list">
                            ${this.nodes.map(node => `
                                <div class="node-item ${this.currentNode?.id === node.id ? 'selected' : ''}" 
                                     onclick="adminManager.selectNode('${node.id}')">
                                    <div class="node-title">${node.title}</div>
                                    <div class="node-id">ID: ${node.id}</div>
                                    <div class="node-position">Position: (${node.mapPos.x}, ${node.mapPos.y})</div>
                                    <div class="node-links">
                                        Links: ${Object.values(node.links).filter(link => link).length}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    setupAdminEventListeners() {
        const nodeForm = document.getElementById('node-form');
        if (nodeForm) {
            nodeForm.addEventListener('submit', (e) => this.saveNode(e));
        }
    }

    showTab(tabName) {
        this.currentTab = tabName;
        const adminContent = document.getElementById('admin-content');
        
        switch(tabName) {
            case 'nodes':
                adminContent.innerHTML = this.renderNodesTab();
                break;
            case 'images':
                adminContent.innerHTML = this.renderImagesTab();
                break;
            case 'map':
                adminContent.innerHTML = this.renderMapTab();
                this.setupMapEditor();
                break;
            case 'preview':
                adminContent.innerHTML = this.renderPreviewTab();
                break;
        }
        
        document.querySelectorAll('.admin-tab').forEach(tab => {
            tab.classList.toggle('active', tab.textContent.includes(this.getTabEmoji(tabName)));
        });
        
        this.setupAdminEventListeners();
    }

    getTabEmoji(tabName) {
        const emojis = {
            'nodes': '📍',
            'images': '🖼️',
            'map': '🗺️',
            'preview': '👁️'
        };
        return emojis[tabName] || '📁';
    }

    renderImagesTab() {
        if (!this.currentNode) {
            return `
                <div class="no-selection">
                    <h3>🖼️ Smart Image Builder</h3>
                    <p>Select a node from the Node Management tab to start building your navigation flow.</p>
                    <div class="creation-mode-toggle">
                        <label>
                            <input type="checkbox" id="auto-create-toggle" ${this.autoCreateMode ? 'checked' : ''} 
                                   onchange="adminManager.toggleAutoCreateMode(this.checked)">
                            🤖 Enable Auto Node Creation
                        </label>
                        <p class="mode-help">When enabled: Uploading an image will automatically create linked nodes</p>
                    </div>
                </div>
            `;
        }

        return `
            <div class="image-upload-panel">
                <div class="upload-header">
                    <h3>🖼️ Building from: ${this.currentNode.title}</h3>
                    <div class="creation-mode-toggle">
                        <label>
                            <input type="checkbox" id="auto-create-toggle" ${this.autoCreateMode ? 'checked' : ''} 
                                   onchange="adminManager.toggleAutoCreateMode(this.checked)">
                            🤖 Auto-Create Mode: ${this.autoCreateMode ? 'ON' : 'OFF'}
                        </label>
                    </div>
                </div>
                
                <div class="build-instructions">
                    <p><strong>Smart Building Flow:</strong></p>
                    <ol>
                        <li>Upload images for each direction below</li>
                        <li>When Auto-Create is ON, new nodes are automatically created</li>
                        <li>Click on any uploaded image to continue building from that point</li>
                        <li>Repeat until your entire campus is mapped!</li>
                    </ol>
                </div>
                
                <div class="direction-uploads">
                    ${['front', 'back', 'left', 'right'].map(direction => {
                        const linkedNodeId = this.currentNode.links[direction];
                        const linkedNode = linkedNodeId ? this.nodes.find(n => n.id === linkedNodeId) : null;
                        const hasImage = this.currentNode.images && this.currentNode.images[direction];
                        
                        return `
                            <div class="direction-upload ${hasImage ? 'has-image' : ''}">
                                <h4>${direction.toUpperCase()} View 
                                    ${linkedNode ? `<span class="linked-badge">→ ${linkedNode.title}</span>` : ''}
                                </h4>
                                <div class="upload-area" id="upload-${direction}"
                                     onclick="adminManager.handleDirectionClick('${direction}')">
                                    <input type="file" id="file-${direction}" accept="image/*" 
                                           onchange="adminManager.handleDirectionUpload('${direction}')" 
                                           style="display: none;">
                                    <label for="file-${direction}" class="upload-label">
                                        ${hasImage ? '🔄 Replace Image' : '📸 Upload ' + direction + ' Image'}
                                    </label>
                                    <div class="image-preview" id="preview-${direction}">
                                        ${hasImage ? 
                                            `<img src="${this.currentNode.images[direction]}" alt="${direction} view" 
                                                  class="preview-img ${linkedNode ? 'clickable' : ''}"
                                                  onclick="adminManager.navigateToLinkedNode('${direction}')">` : 
                                            '<p>No image uploaded</p>'
                                        }
                                    </div>
                                    ${hasImage && linkedNode ? `
                                        <div class="preview-actions">
                                            <button onclick="adminManager.continueBuildingFrom('${direction}')" 
                                                    class="btn-continue">Continue Building →</button>
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                
                <div class="bulk-upload">
                    <h4>📦 Bulk Upload (Advanced)</h4>
                    <input type="file" id="bulk-upload" accept="image/*" multiple 
                           onchange="adminManager.handleBulkUpload()">
                    <p>Upload multiple images at once. Name files with direction (e.g., "gate-front.jpg")</p>
                </div>
                
                <div class="current-progress">
                    <h4>📊 Building Progress</h4>
                    <div class="progress-stats">
                        <div>Total Nodes: ${this.nodes.length}</div>
                        <div>Images Uploaded: ${this.countUploadedImages()}</div>
                        <div>Connections: ${this.countConnections()}</div>
                    </div>
                </div>
            </div>
        `;
    }

    async handleDirectionUpload(direction) {
        const fileInput = document.getElementById(`file-${direction}`);
        const file = fileInput.files[0];
        
        if (!file || !this.currentNode) return;
        
        this.pendingDirection = direction;
        await this.uploadImage(file, direction);
    }

    async uploadImage(file, direction) {
        const formData = new FormData();
        formData.append('image', file);
        formData.append('direction', direction);
        
        try {
            const response = await fetch(`/api/upload/node/${this.currentNode.id}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });
            
            if (response.ok) {
                const result = await response.json();
                this.showMessage('✅ Image uploaded successfully!', 'success');
                
                this.updateImagePreview(direction, result.path);
                
                if (this.autoCreateMode && this.pendingDirection) {
                    await this.autoCreateLinkedNode(this.pendingDirection, result.path);
                    this.pendingDirection = null;
                }
                
                await this.loadNodes();
            } else {
                this.showMessage('❌ Error uploading image', 'error');
            }
        } catch (error) {
            console.error('Error uploading image:', error);
            this.showMessage('❌ Upload failed', 'error');
        }
    }

    async autoCreateLinkedNode(direction, imagePath) {
        if (!this.currentNode || this.currentNode.links[direction]) return;
        
        const newNodeId = `${this.currentNode.id}-${direction}`;
        const newNodeTitle = `${this.currentNode.title} - ${direction.toUpperCase()}`;
        
        const oppositeDirection = this.getOppositeDirection(direction);
        
        const newNodeData = {
            id: newNodeId,
            title: newNodeTitle,
            mapPos: {
                x: this.currentNode.mapPos.x + (direction === 'right' ? 100 : direction === 'left' ? -100 : 0),
                y: this.currentNode.mapPos.y + (direction === 'front' ? -100 : direction === 'back' ? 100 : 0)
            },
            floor: this.currentNode.floor,
            links: { 
                front: null, 
                back: null, 
                left: null, 
                right: null,
                [oppositeDirection]: this.currentNode.id
            },
            images: { [oppositeDirection]: imagePath },
            meta: {
                building: this.currentNode.meta?.building || '',
                notes: `Auto-created from ${this.currentNode.title}`
            }
        };
        
        try {
            const response = await fetch('/api/nodes', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(newNodeData)
            });
            
            if (response.ok) {
                const updateData = {
                    ...this.currentNode,
                    links: {
                        ...this.currentNode.links,
                        [direction]: newNodeId
                    }
                };
                
                await fetch(`/api/nodes/${this.currentNode.id}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(updateData)
                });
                
                this.showMessage(`✅ Auto-created linked node: ${newNodeTitle}`, 'success');
                await this.loadNodes();
                
                this.selectNode(newNodeId);
            }
        } catch (error) {
            console.error('Error auto-creating node:', error);
        }
    }

    getOppositeDirection(direction) {
        const opposites = {
            'front': 'back',
            'back': 'front',
            'left': 'right',
            'right': 'left'
        };
        return opposites[direction] || 'front';
    }

    handleDirectionClick(direction) {
        const linkedNodeId = this.currentNode.links[direction];
        if (linkedNodeId) {
            this.selectNode(linkedNodeId);
        }
    }

    navigateToLinkedNode(direction) {
        const linkedNodeId = this.currentNode.links[direction];
        if (linkedNodeId) {
            this.selectNode(linkedNodeId);
            this.showTab('images');
        }
    }

    continueBuildingFrom(direction) {
        const linkedNodeId = this.currentNode.links[direction];
        if (linkedNodeId) {
            this.selectNode(linkedNodeId);
            this.showTab('images');
            this.showMessage(`🎯 Now building from: ${this.currentNode.title}`, 'success');
        }
    }

    toggleAutoCreateMode(enabled) {
        this.autoCreateMode = enabled;
        this.showMessage(`🤖 Auto-Create Mode: ${enabled ? 'ENABLED' : 'DISABLED'}`, 'success');
        
        if (this.currentTab === 'images') {
            this.showTab('images');
        }
    }

    countUploadedImages() {
        return this.nodes.reduce((count, node) => {
            return count + (node.images ? Object.keys(node.images).length : 0);
        }, 0);
    }

    countConnections() {
        return this.nodes.reduce((count, node) => {
            return count + Object.values(node.links).filter(link => link).length;
        }, 0);
    }

    selectNode(nodeId) {
        this.currentNode = this.nodes.find(n => n.id === nodeId);
        this.populateNodeForm();
        this.populateNodeList();
        
        if (this.currentTab === 'images') {
            this.showTab('images');
        }
    }

    async handleBulkUpload() {
        const fileInput = document.getElementById('bulk-upload');
        const files = Array.from(fileInput.files);
        
        if (!files.length || !this.currentNode) return;
        
        this.showMessage(`📦 Processing ${files.length} files...`, 'success');
        
        for (let file of files) {
            const direction = this.extractDirectionFromFilename(file.name) || 'front';
            this.pendingDirection = direction;
            await this.uploadImage(file, direction);
        }
        
        this.showMessage('✅ Bulk upload completed!', 'success');
    }

    extractDirectionFromFilename(filename) {
        const lowerName = filename.toLowerCase();
        if (lowerName.includes('front') || lowerName.includes('forward')) return 'front';
        if (lowerName.includes('back') || lowerName.includes('rear') || lowerName.includes('backward')) return 'back';
        if (lowerName.includes('left')) return 'left';
        if (lowerName.includes('right')) return 'right';
        return null;
    }

    updateImagePreview(direction, imagePath) {
        const preview = document.getElementById(`preview-${direction}`);
        if (preview) {
            preview.innerHTML = `<img src="${imagePath}" alt="${direction} view" class="preview-img">`;
        }
    }

    showMessage(message, type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            z-index: 1000;
            ${type === 'success' ? 'background: #27ae60;' : 'background: #e74c3c;'}
        `;
        
        document.body.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.remove();
        }, 3000);
    }

    async saveNode(e) {
        e.preventDefault();
        
        const nodeData = {
            id: document.getElementById('node-id').value,
            title: document.getElementById('node-title').value,
            mapPos: {
                x: parseInt(document.getElementById('node-pos-x').value) || 300,
                y: parseInt(document.getElementById('node-pos-y').value) || 200
            },
            floor: parseInt(document.getElementById('node-floor').value) || 0,
            links: {
                front: document.getElementById('link-front').value || null,
                back: document.getElementById('link-back').value || null,
                left: document.getElementById('link-left').value || null,
                right: document.getElementById('link-right').value || null
            },
            meta: {
                building: document.getElementById('node-building').value || '',
                notes: document.getElementById('node-notes').value || ''
            }
        };
        
        try {
            const isNew = !this.nodes.find(n => n.id === nodeData.id);
            const url = isNew ? '/api/nodes' : `/api/nodes/${nodeData.id}`;
            const method = isNew ? 'POST' : 'PUT';
            
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(nodeData)
            });
            
            if (response.ok) {
                this.showMessage(`✅ Node ${isNew ? 'created' : 'updated'} successfully!`, 'success');
                await this.loadNodes();
                this.populateNodeList();
                
                if (isNew) {
                    this.newNode();
                }
            } else {
                const error = await response.json();
                this.showMessage(`❌ Error: ${error.error}`, 'error');
            }
        } catch (error) {
            console.error('Error saving node:', error);
            this.showMessage('❌ Error saving node', 'error');
        }
    }

    populateNodeForm() {
        if (!this.currentNode) return;
        
        document.getElementById('node-id').value = this.currentNode.id;
        document.getElementById('node-title').value = this.currentNode.title;
        document.getElementById('node-pos-x').value = this.currentNode.mapPos.x;
        document.getElementById('node-pos-y').value = this.currentNode.mapPos.y;
        document.getElementById('node-floor').value = this.currentNode.floor;
        document.getElementById('node-building').value = this.currentNode.meta?.building || '';
        document.getElementById('node-notes').value = this.currentNode.meta?.notes || '';
        
        document.getElementById('link-front').value = this.currentNode.links.front || '';
        document.getElementById('link-back').value = this.currentNode.links.back || '';
        document.getElementById('link-left').value = this.currentNode.links.left || '';
        document.getElementById('link-right').value = this.currentNode.links.right || '';
    }

    populateNodeList() {
        const nodeList = document.getElementById('node-list');
        if (nodeList) {
            nodeList.innerHTML = this.nodes.map(node => `
                <div class="node-item ${this.currentNode?.id === node.id ? 'selected' : ''}" 
                     onclick="adminManager.selectNode('${node.id}')">
                    <div class="node-title">${node.title}</div>
                    <div class="node-id">ID: ${node.id}</div>
                    <div class="node-position">Position: (${node.mapPos.x}, ${node.mapPos.y})</div>
                    <div class="node-links">
                        Links: ${Object.values(node.links).filter(link => link).length}
                    </div>
                </div>
            `).join('');
        }
    }

    newNode() {
        this.currentNode = null;
        const form = document.getElementById('node-form');
        if (form) form.reset();
        this.populateNodeList();
    }

    async deleteNode() {
        if (!this.currentNode) return;
        
        if (!confirm(`Are you sure you want to delete node "${this.currentNode.title}"? This action cannot be undone.`)) return;
        
        try {
            const response = await fetch(`/api/nodes/${this.currentNode.id}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (response.ok) {
                this.showMessage('✅ Node deleted successfully!', 'success');
                await this.loadNodes();
                this.populateNodeList();
                this.newNode();
            } else {
                this.showMessage('❌ Error deleting node', 'error');
            }
        } catch (error) {
            console.error('Error deleting node:', error);
            this.showMessage('❌ Error deleting node', 'error');
        }
    }

    renderMapTab() {
        return `<div class="map-editor-tab">Map Editor Content</div>`;
    }

    renderPreviewTab() {
        return `<div class="preview-tab">Navigation Preview Content</div>`;
    }

    setupMapEditor() {
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.adminManager = new AdminManager();
});