
class CampusNavi {
    constructor() {
        this.currentNode = null;
        this.nodes = [];
        this.user = null;
        this.token = null;
        this.isAdmin = false;
        this.currentView = '3d';
        this.currentDirection = 'front';
        this.imageCache = new Map();
        this.map = {
            canvas: null,
            ctx: null,
            zoom: 1,
            offset: { x: 0, y: 0 },
            dragging: false,
            dragStart: { x: 0, y: 0 }
        };
        
        this.init();
    }

    async init() {
        // Get user info from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const userParam = urlParams.get('user');
        this.token = urlParams.get('token');
        
        if (userParam) {
            try {
                this.user = JSON.parse(decodeURIComponent(userParam));
                this.isAdmin = this.user.role === 'admin';
                this.updateUserInfo();
            } catch (error) {
                console.error('Error parsing user data:', error);
            }
        }

        await this.loadNodes();
        this.setupEventListeners();
        this.setupMap();
        
        // Start at first node
        if (this.nodes.length > 0) {
            this.goToNode(this.nodes[0].id);
        }
        
        // Preload adjacent node images
        this.preloadAdjacentImages();
    }

    async loadNodes() {
        try {
            const response = await fetch('/api/nodes', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            
            if (response.ok) {
                this.nodes = await response.json();
                this.renderMap();
            } else {
                console.error('Failed to load nodes');
            }
        } catch (error) {
            console.error('Error loading nodes:', error);
        }
    }

    updateUserInfo() {
        const userInfoEl = document.getElementById('cn-user-info');
        if (userInfoEl && this.user) {
            userInfoEl.innerHTML = `
                <i class="user-icon">👤</i>
                ${this.user.displayName} 
                <span class="user-role">(${this.user.role})</span>
            `;
        }

        const adminBtn = document.getElementById('admin-btn');
        if (adminBtn) {
            adminBtn.classList.toggle('hidden', !this.isAdmin);
        }
    }

    setupEventListeners() {
        // View toggle
        document.getElementById('toggle-3d').addEventListener('click', () => this.switchView('3d'));
        document.getElementById('toggle-2d').addEventListener('click', () => this.switchView('2d'));
        
        // Admin button
        document.getElementById('admin-btn').addEventListener('click', () => this.toggleAdminMode());
        
        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyPress(e));
        
        // Back button - goes back to main PAU_Edu_Orbit page
        window.goBack = () => {
            window.location.href = '/'; // Go back to main site
        };
    }

    setupMap() {
        this.map.canvas = document.getElementById('map-canvas');
        if (!this.map.canvas) return;
        
        this.map.ctx = this.map.canvas.getContext('2d');
        
        this.map.canvas.addEventListener('mousedown', (e) => this.startDrag(e));
        this.map.canvas.addEventListener('mousemove', (e) => this.drag(e));
        this.map.canvas.addEventListener('mouseup', () => this.endDrag());
        this.map.canvas.addEventListener('wheel', (e) => this.handleZoom(e));
        
        this.resizeMap();
        window.addEventListener('resize', () => this.resizeMap());
    }

    resizeMap() {
        if (this.map.canvas) {
            this.map.canvas.width = this.map.canvas.offsetWidth;
            this.map.canvas.height = this.map.canvas.offsetHeight;
            this.renderMap();
        }
    }

    switchView(view) {
        this.currentView = view;
        
        // Update toggle buttons
        document.getElementById('toggle-3d').classList.toggle('active', view === '3d');
        document.getElementById('toggle-2d').classList.toggle('active', view === '2d');
        
        // Show/hide viewers
        document.getElementById('viewer-3d').classList.toggle('active', view === '3d');
        document.getElementById('viewer-2d').classList.toggle('active', view === '2d');
        
        if (view === '2d') {
            this.renderMap();
        }
    }

    async preloadAdjacentImages() {
        if (!this.currentNode) return;
        
        const directions = ['front', 'back', 'left', 'right'];
        for (const direction of directions) {
            const linkedNodeId = this.currentNode.links[direction];
            if (linkedNodeId) {
                const linkedNode = this.nodes.find(n => n.id === linkedNodeId);
                if (linkedNode && linkedNode.images) {
                    const oppositeDir = this.getOppositeDirection(direction);
                    const imageUrl = linkedNode.images[oppositeDir] || linkedNode.images.front;
                    await this.preloadImage(imageUrl);
                }
            }
        }
    }

    async preloadImage(url) {
        return new Promise((resolve) => {
            if (!url || this.imageCache.has(url)) {
                resolve();
                return;
            }
            
            const img = new Image();
            img.onload = () => {
                this.imageCache.set(url, img);
                resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
        });
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

    async goToNode(nodeId, direction = 'front') {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) return;

        this.currentNode = node;
        this.currentDirection = direction;
        
        // Show loading
        const imageElement = document.getElementById('current-image');
        imageElement.style.opacity = '0.3';
        
        // Add loading spinner
        this.showLoadingSpinner();
        
        try {
            const imagePath = node.images[direction] || node.images.front;
            
            // Use cached image if available
            if (this.imageCache.has(imagePath)) {
                imageElement.src = this.imageCache.get(imagePath).src;
            } else {
                await this.preloadImage(imagePath);
                imageElement.src = imagePath;
            }
            
            // Update location info
            this.updateLocationInfo(node);
            
            // Wait for image to load or use cached version
            await new Promise((resolve) => {
                if (imageElement.complete) {
                    resolve();
                } else {
                    imageElement.onload = resolve;
                    imageElement.onerror = resolve;
                }
            });
            
            // Apply smooth transition
            this.applyImageTransition(imageElement);
            
            // Preload adjacent images for smoother navigation
            setTimeout(() => this.preloadAdjacentImages(), 500);
            
        } catch (error) {
            console.error('Error loading image:', error);
            this.hideLoadingSpinner();
            imageElement.style.opacity = '1';
        }
    }

    showLoadingSpinner() {
        const imageViewer = document.querySelector('.image-viewer');
        let spinner = imageViewer.querySelector('.loading-spinner');
        
        if (!spinner) {
            spinner = document.createElement('div');
            spinner.className = 'loading-spinner';
            imageViewer.appendChild(spinner);
        }
    }

    hideLoadingSpinner() {
        const spinner = document.querySelector('.loading-spinner');
        if (spinner) {
            spinner.remove();
        }
    }

    applyImageTransition(imageElement) {
        imageElement.classList.remove('fade-slide-enter', 'fade-slide-exit');
        void imageElement.offsetWidth; // Trigger reflow
        
        imageElement.classList.add('fade-slide-enter');
        imageElement.style.opacity = '1';
        
        this.hideLoadingSpinner();
        
        setTimeout(() => {
            imageElement.classList.remove('fade-slide-enter');
        }, 400);
    }

    updateLocationInfo(node) {
        const locationElement = document.getElementById('current-location');
        const detailsElement = document.getElementById('location-details');
        
        locationElement.textContent = node.title;
        
        let detailsHtml = `
            <div class="location-meta">
                <strong>Building:</strong> ${node.meta.building || 'Unknown'}<br>
                <strong>Floor:</strong> ${node.floor || 'Ground'}<br>
                ${node.meta.notes ? `<strong>Notes:</strong> ${node.meta.notes}` : ''}
            </div>
        `;
        
        // Add available directions
        const availableDirs = Object.entries(node.links)
            .filter(([dir, link]) => link)
            .map(([dir]) => dir);
            
        if (availableDirs.length > 0) {
            detailsHtml += `
                <div class="direction-hints">
                    <h4>Available Directions:</h4>
                    <div class="directions-list">
                        ${availableDirs.map(dir => 
                            `<span class="direction-tag">${dir.toUpperCase()}</span>`
                        ).join(' ')}
                    </div>
                    <p style="margin-top: 0.5rem; font-size: 0.9rem; color: #64b6ac;">
                        Use WASD keys or arrow buttons to navigate
                    </p>
                </div>
            `;
        }
        
        detailsElement.innerHTML = detailsHtml;
    }

    move(direction) {
        if (!this.currentNode || !this.currentNode.links[direction]) {
            // No link in this direction - show shake animation
            this.showInvalidMoveFeedback(direction);
            return;
        }
        
        const nextNodeId = this.currentNode.links[direction];
        const oppositeDirection = this.getOppositeDirection(direction);
        this.goToNode(nextNodeId, oppositeDirection);
    }

    showInvalidMoveFeedback(direction) {
        const button = document.querySelector(`.nav-btn.${direction}`);
        if (button) {
            button.classList.add('shake');
            setTimeout(() => button.classList.remove('shake'), 400);
        }
        
        // Show message in location info
        const detailsElement = document.getElementById('location-details');
        const tempMsg = document.createElement('div');
        tempMsg.style.color = '#e74c3c';
        tempMsg.style.fontWeight = '600';
        tempMsg.textContent = `Cannot move ${direction} from this location`;
        tempMsg.className = 'invalid-move-message';
        
        detailsElement.appendChild(tempMsg);
        setTimeout(() => tempMsg.remove(), 2000);
    }

    handleKeyPress(e) {
        if (this.currentView !== '3d') return;
        
        const keyActions = {
            'ArrowUp': 'front',
            'ArrowDown': 'back',
            'ArrowLeft': 'left',
            'ArrowRight': 'right',
            'w': 'front', 'W': 'front',
            's': 'back', 'S': 'back',
            'a': 'left', 'A': 'left',
            'd': 'right', 'D': 'right'
        };
        
        const direction = keyActions[e.key];
        if (direction) {
            e.preventDefault();
            this.move(direction);
        }
    }

    // Enhanced Map functionality
    startDrag(e) {
        this.map.dragging = true;
        this.map.dragStart = { x: e.clientX, y: e.clientY };
        this.map.canvas.style.cursor = 'grabbing';
    }

    drag(e) {
        if (!this.map.dragging) return;
        
        const dx = e.clientX - this.map.dragStart.x;
        const dy = e.clientY - this.map.dragStart.y;
        
        this.map.offset.x += dx;
        this.map.offset.y += dy;
        
        this.map.dragStart = { x: e.clientX, y: e.clientY };
        this.renderMap();
    }

    endDrag() {
        this.map.dragging = false;
        this.map.canvas.style.cursor = 'grab';
    }

    handleZoom(e) {
        e.preventDefault();
        const zoomIntensity = 0.1;
        const wheel = e.deltaY < 0 ? 1 : -1;
        const zoom = Math.exp(wheel * zoomIntensity);
        
        this.map.zoom *= zoom;
        this.map.zoom = Math.max(0.1, Math.min(5, this.map.zoom));
        this.renderMap();
    }

    renderMap() {
        if (!this.map.ctx || !this.map.canvas) return;
        
        const ctx = this.map.ctx;
        const width = this.map.canvas.width;
        const height = this.map.canvas.height;
        
        // Clear canvas with gradient
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#2d2d2d');
        gradient.addColorStop(1, '#3d3d3d');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        
        // Calculate center with offset
        const centerX = width / 2 + this.map.offset.x;
        const centerY = height / 2 + this.map.offset.y;
        
        // Draw grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        
        const gridSize = 50 * this.map.zoom;
        const startX = centerX % gridSize;
        const startY = centerY % gridSize;
        
        for (let x = startX; x < width; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        
        for (let y = startY; y < height; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        
        // Draw connection lines first
        ctx.strokeStyle = 'rgba(102, 126, 234, 0.6)';
        ctx.lineWidth = 3 * this.map.zoom;
        
        this.nodes.forEach(node => {
            const nodeX = centerX + (node.mapPos.x - 300) * this.map.zoom;
            const nodeY = centerY + (node.mapPos.y - 200) * this.map.zoom;
            
            Object.entries(node.links).forEach(([direction, targetId]) => {
                if (targetId) {
                    const targetNode = this.nodes.find(n => n.id === targetId);
                    if (targetNode) {
                        const targetX = centerX + (targetNode.mapPos.x - 300) * this.map.zoom;
                        const targetY = centerY + (targetNode.mapPos.y - 200) * this.map.zoom;
                        
                        ctx.beginPath();
                        ctx.moveTo(nodeX, nodeY);
                        ctx.lineTo(targetX, targetY);
                        ctx.stroke();
                        
                        // Draw direction arrow
                        this.drawDirectionArrow(ctx, nodeX, nodeY, targetX, targetY, direction);
                    }
                }
            });
        });
        
        // Draw nodes on top
        this.nodes.forEach(node => {
            const x = centerX + (node.mapPos.x - 300) * this.map.zoom;
            const y = centerY + (node.mapPos.y - 200) * this.map.zoom;
            const radius = 10 * this.map.zoom;
            
            // Node circle with gradient
            const gradient = ctx.createRadialGradient(x, y, radius * 0.5, x, y, radius);
            gradient.addColorStop(0, node.id === this.currentNode?.id ? '#e74c3c' : '#667eea');
            gradient.addColorStop(1, node.id === this.currentNode?.id ? '#c0392b' : '#764ba2');
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, 2 * Math.PI);
            ctx.fill();
            
            // Node border
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2 * this.map.zoom;
            ctx.stroke();
            
            // Node label
            ctx.fillStyle = 'white';
            ctx.font = `${12 * this.map.zoom}px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText(node.title, x, y - radius - 8 * this.map.zoom);
        });
        
        // Store node positions for click detection
        this.nodePositions = this.nodes.map(node => ({
            id: node.id,
            x: centerX + (node.mapPos.x - 300) * this.map.zoom,
            y: centerY + (node.mapPos.y - 200) * this.map.zoom,
            radius: 10 * this.map.zoom
        }));
    }

    drawDirectionArrow(ctx, fromX, fromY, toX, toY, direction) {
        const headlen = 15 * this.map.zoom;
        const dx = toX - fromX;
        const dy = toY - fromY;
        const angle = Math.atan2(dy, dx);
        
        // Calculate arrow position (closer to target)
        const arrowX = fromX + dx * 0.7;
        const arrowY = fromY + dy * 0.7;
        
        ctx.fillStyle = '#64b6ac';
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(arrowX - headlen * Math.cos(angle - Math.PI/6), arrowY - headlen * Math.sin(angle - Math.PI/6));
        ctx.lineTo(arrowX - headlen * Math.cos(angle + Math.PI/6), arrowY - headlen * Math.sin(angle + Math.PI/6));
        ctx.closePath();
        ctx.fill();
    }

    zoomIn() {
        this.map.zoom *= 1.2;
        this.map.zoom = Math.min(5, this.map.zoom);
        this.renderMap();
    }

    zoomOut() {
        this.map.zoom /= 1.2;
        this.map.zoom = Math.max(0.1, this.map.zoom);
        this.renderMap();
    }

    resetView() {
        this.map.zoom = 1;
        this.map.offset = { x: 0, y: 0 };
        this.renderMap();
    }

    toggleAdminMode() {
        if (window.adminManager) {
            window.adminManager.toggle();
        }
    }

    // Handle map clicks for node selection
    setupMapClickHandler() {
    if (!this.map.canvas) return;
    
    this.map.canvas.addEventListener('click', (e) => {
        if (!this.nodePositions) return;
        
        const rect = this.map.canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        
        const clickedNode = this.nodePositions.find(node => {
            const distance = Math.sqrt((clickX - node.x) ** 2 + (clickY - node.y) ** 2);
            return distance <= node.radius;
        });
        
        if (clickedNode) {
            this.goToNode(clickedNode.id);
            this.switchView('3d');
        }
    });
}
}

// Enhanced global functions
function goBack() {
    window.location.href = '/'; // Back to main PAU_Edu_Orbit site
}

function move(direction) {
    if (window.campusNavi) {
        window.campusNavi.move(direction);
    }
}

function zoomIn() {
    if (window.campusNavi) {
        window.campusNavi.zoomIn();
    }
}

function zoomOut() {
    if (window.campusNavi) {
        window.campusNavi.zoomOut();
    }
}

function resetView() {
    if (window.campusNavi) {
        window.campusNavi.resetView();
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.campusNavi = new CampusNavi();
    window.campusNavi.setupMapClickHandler();
});
