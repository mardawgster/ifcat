class IMU3DCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.cube = null;
    this.sceneLoaded = false;
  }

  setConfig(config) {
    if (!config.pitch_entity || !config.roll_entity || !config.yaw_entity) {
      throw new Error('You must define pitch_entity, roll_entity, and yaw_entity');
    }
    this.config = config;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <ha-card header="${this.config.title || 'IMU Orientation'}">
        <div id="container" style="width: 100%; height: 350px; display: flex; justify-content: center; align-items: center; background: #111; border-radius: 0 0 12px 12px; overflow: hidden;">
          <span id="status" style="color: white; font-family: sans-serif;">Loading 3D Engine...</span>
        </div>
      </ha-card>
    `;
    this.container = this.shadowRoot.querySelector('#container');
    this.statusText = this.shadowRoot.querySelector('#status');
    
    this.initThree();
  }

  async initThree() {
    try {
      // Switched to esm.sh to perfectly resolve browser module dependencies
      const THREE = await import('https://esm.sh/three@0.160.0');
      const { GLTFLoader } = await import('https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js');
      
      if (this.statusText) this.statusText.style.display = 'none';
      
      this.scene = new THREE.Scene();
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
      this.scene.add(ambientLight);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(5, 10, 7.5);
      this.scene.add(directionalLight);

      const width = this.container.clientWidth || 300;
      this.camera = new THREE.PerspectiveCamera(50, width / 350, 0.1, 1000);
      
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setSize(width, 350);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace; 
      this.container.appendChild(this.renderer.domElement);

      const loader = new GLTFLoader();
      loader.load(
        '/local/artifact.glb',
        (gltf) => {
          this.cube = gltf.scene; 
          
          // 1. Calculate the bounding box of the imported model
          const box = new THREE.Box3().setFromObject(this.cube);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());

          // 2. Automatically scale the model to fit perfectly in view
          // We force the maximum dimension (X, Y, or Z) to be exactly 4 units wide
          const maxDim = Math.max(size.x, size.y, size.z);
          const targetSize = 3.0; // Adjust this if you want it larger or smaller in the window
          const scale = targetSize / maxDim;
          
          this.cube.scale.set(scale, scale, scale);

          // 3. Recalculate the box after scaling, then center it
          const scaledBox = new THREE.Box3().setFromObject(this.cube);
          const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
          
          this.cube.position.x += (this.cube.position.x - scaledCenter.x);
          this.cube.position.y += (this.cube.position.y - scaledCenter.y);
          this.cube.position.z += (this.cube.position.z - scaledCenter.z);
          
          this.scene.add(this.cube);
          if (this._hass) this.updateRotation();
        },
        undefined, 
        (error) => {
          console.error('Error loading artifact.glb:', error);
          if (this.statusText) {
            this.statusText.style.display = 'block';
            this.statusText.textContent = 'Failed to load artifact.glb. Check console.';
          }
        }
      );
      
      this.camera.position.z = 6;
      this.camera.position.y = 2;
      this.camera.lookAt(0, 0, 0);

      this.resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            this.renderer.setSize(width, height);
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            if (this.cube) this.renderer.render(this.scene, this.camera);
          }
        }
      });
      this.resizeObserver.observe(this.container);
      
      this.sceneLoaded = true;

    } catch (error) {
      console.error("3D Engine Load Error:", error);
      if (this.statusText) {
        this.statusText.textContent = 'Network blocked 3D engine. Check console.';
        this.statusText.style.color = '#ff6b6b';
      }
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this.sceneLoaded) this.updateRotation();
  }

  updateRotation() {
    if (!this.cube || !this._hass) return;

    const pitch = parseFloat(this._hass.states[this.config.pitch_entity]?.state) || 0;
    const roll = parseFloat(this._hass.states[this.config.roll_entity]?.state) || 0;
    const yaw = parseFloat(this._hass.states[this.config.yaw_entity]?.state) || 0;

    const deg2rad = Math.PI / 180;
    this.cube.rotation.order = 'YXZ';
    this.cube.rotation.x = roll * deg2rad;
    this.cube.rotation.z = pitch * deg2rad * -1;
    this.cube.rotation.y = yaw * deg2rad; 

    this.renderer.render(this.scene, this.camera);
  }

  getCardSize() { return 4; }

  disconnectedCallback() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }
}

customElements.define('imu-3d-card', IMU3DCard);