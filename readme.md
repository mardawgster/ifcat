# Innovation Factory Cyber-Physical Assembly Testbed

![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.x%2B-41BDF5?logo=home-assistant&logoColor=white)
![ESPHome](https://img.shields.io/badge/ESPHome-ESP32-000000?logo=esphome&logoColor=white)
![MQTT](https://img.shields.io/badge/Telemetry-100ms%20MQTT-660066?logo=eclipse-mosquitto&logoColor=white)
![WebGL](https://img.shields.io/badge/3D%20Visualizer-WebGL%20%2F%20GLB-FF6F00?logo=three.js&logoColor=white)

A modular, scalable firmware and Home Assistant backend architecture for a multi-station manual assembly testbed. Each assembly station features **8 independent HX711 load cell bins** with real-time digital signal processing (DSP), dynamic part-weight catalog syncing, high-frequency `100ms` MQTT telemetry logging, real-time 3D artifact orientation and Bill of Materials (BOM) tracking across stations, and an automated optical/RPM artifact quality verification system.

---

## Table of Contents
1. [Repository Structure & File Reference](#repository-structure--file-reference)
2. [System Architecture & Core Subsystems](#system-architecture--core-subsystems)
3. [Prerequisites](#prerequisites)
4. [Step-by-Step Installation Guide](#step-by-step-installation-guide)
5. [Standard Operating Procedures (SOP)](#standard-operating-procedures-sop)
6. [Scaling the Testbed](#scaling-the-testbed)
7. [Tunable Parameters & Engineering Reference](#tunable-parameters--engineering-reference)
8. [Hardware Best Practices](#hardware-best-practices)

---

## Repository Structure & File Reference

The repository mirrors the target `/config/` directory structure of a production Home Assistant instance:

```text
└── homeassistant/
    ├── configuration.yaml                    # Core HA config: enables packages, QC rig logic, stepper REST commands & artifact tracking
    ├── custom_templates/
    │   └── artifact_tracking.jinja           # Reusable Jinja2 macros for station part-consumption & BOM verification
    ├── packages/
    │   └── parts_catalog.yaml                # Self-contained Master Parts DB, scripts, dropdowns & auto-discovery automations
    ├── www/
    │   ├── artifact.glb                      # 3D GLTF/GLB model of the smart artifact for real-time dashboard rendering
    │   └── imu-visualizer.js                 # Custom Lovelace WebGL card script for real-time 3D roll/pitch/yaw visualization
    ├── dashboards/
    │   ├── full-assy-line-dashboard.yaml     # Complete multi-view Lovelace dashboard for all stations & quality control
    │   ├── imu-visualizer.yaml               # Standalone Lovelace YAML for the 3D Artifact IMU Visualizer card
    │   ├── parts-catalog.yaml                # Standalone Lovelace YAML for the Master Parts Catalog manager card
    │   └── quality-control-card.yaml         # Standalone Lovelace YAML for the Quality Check HUD & tactile rig controls
    └── esphome/
        ├── assembly-station-1.yaml           # Station 1 ESP32 node definition (substitutions, Wi-Fi/OTA, includes common config)
        ├── assembly-01.yaml                  # Smart Artifact 01 ESP32 node definition (includes artifact_config.yaml)
        ├── madgwick_sensor.h                 # Custom C++ sensor header implementing Madgwick quaternion AHRS IMU fusion
        └── common/
            ├── assembly_station_config.yaml  # Shared station config: 8x load_cell_template includes & 100ms MQTT telemetry
            ├── load_cell_template.yaml       # Parameterized single load-cell DSP, Kalman filter & calibration template
            └── artifact_config.yaml          # Shared smart artifact config (IMU motion gates, BLE/station tracking, RPM telemetry)
```

### Component Breakdown

| File Path | Role in the Architecture |
| :--- | :--- |
| **`configuration.yaml`** | Loads the `packages/` directory, defines the stepper motor REST commands (`quality_test`, `stepper_stop`, `stepper_play_fur_elise`), evaluates sliding-window RPM quality checks, and instantiates the active artifact BOM tracker. |
| **`custom_templates/artifact_tracking.jinja`** | Provides Jinja2 macros (`station_part_inventory`, `station_parts_picked`, `verify_artifact_bom`) that calculate real-time part consumption deltas across all 8 bins of the active station. |
| **`packages/parts_catalog.yaml`** | Implements the event-driven Master Parts Database (`sensor.master_parts_catalog`), CRUD scripts, per-bin `input_select` helpers, and regex auto-discovery automations that push unit weights to ESPHome nodes. |
| **`www/imu-visualizer.js` & `artifact.glb`** | Renders a live, interactive 3D digital twin of the artifact on the Home Assistant dashboard driven by roll, pitch, and yaw telemetry from the artifact's onboard IMU. |
| **`esphome/madgwick_sensor.h`** | Performs high-speed onboard quaternion sensor fusion on raw 6-DOF accelerometer and gyroscope readings to output drift-compensated Euler angles (roll, pitch, yaw). |
| **`esphome/common/load_cell_template.yaml`** | Parameterized package instantiated 8 times per station. Contains the HX711 driver, 9-sample median spike filter, adaptive 1D Kalman filter, flash-safe thermal drift tracker, and stability-gated item counter. |
| **`esphome/common/assembly_station_config.yaml`** | Maps the 8 load cells to their physical ESP32 GPIO pins, staggers ADC polling intervals, and broadcasts a unified JSON telemetry payload over MQTT every `100ms` with UNIX millisecond timestamps. |
| **`esphome/common/artifact_config.yaml`** | Shared firmware profile for the mobile smart artifacts, managing IMU orientation streaming, motion-gating, station proximity detection, and optical/hall RPM telemetry. |

---

## System Architecture & Core Subsystems

### 1. Multi-Stage Load Cell DSP Pipeline
Raw HX711 load cell readings are susceptible to ESP32 Wi-Fi current dips, bit-bang timing interrupts, ambient temperature drift, and operator hand pressure. Each load cell executes a 4-stage real-time filter pipeline directly on the station ESP32:
* **Staggered Polling & Spike Rejection (`load_raw`):** The 8 HX711 sensors per station are polled at staggered intervals (`93ms` to `107ms`) to prevent CPU lockups during `100ms` MQTT broadcasts. A 9-sample moving median filter discards momentary bit-shift glitches up to `400ms` long.
* **Adaptive 1D Kalman Filter (`load_mass`):** Dynamically switches process noise covariance ($Q$) between ultra-smooth resting tracking ($Q = 0.0005$) and instantaneous step response ($Q = 2.0$) when a weight change $> 1.2\text{ g}$ is confirmed for 3 consecutive ticks (`300ms`).
* **Flash-Safe Continuous Thermal & Creep Compensation:** Tracks an internal `thermal_anchor` in RAM. Slow, sub-$0.45\text{ g}$ ambient temperature drift and mechanical strain-gauge creep are bled off at $0.5\%$ per tick without writing to ESP32 NVS flash memory—preserving flash lifespan while keeping bins zeroed across HVAC swings.
* **"Hand-in-Bin" Stability Gate & Fractional Hysteresis (`l_item_count`):** Prevents false item-count spikes when an operator reaches into a bin. The item counter freezes whenever the bin weight is actively changing ($\Delta m \ge 0.5\text{ g}$) and only updates after the scale settles for 4 consecutive ticks (`800ms`), using a $\pm 0.60\text{ item}$ deadband to eliminate rounding flicker.

### 2. Smart Artifact Orientation & 3D Digital Twin
Each assembly artifact (`assembly-01.yaml`) contains an embedded ESP32 and 6-axis IMU:
* **Madgwick Quaternion Fusion (`madgwick_sensor.h`):** Raw accelerometer and gyroscope readings are fused onboard into smooth roll, pitch, and yaw angles.
* **Real-Time 3D WebGL Visualizer (`imu-visualizer.js`):** Subscribes to the artifact's orientation entities in Home Assistant and rotates `/local/artifact.glb` in real time on the operator dashboard.

### 3. Dynamic Master Parts Catalog
* **Zero-Reflash Part Management:** Operators can add, edit, or delete parts and their average unit weights directly from the Home Assistant UI (`dashboards/parts-catalog.yaml`).
* **Persistent Event-Driven Database:** Stored inside a trigger-based template sensor (`sensor.master_parts_catalog`) that survives Home Assistant restarts.
* **Regex Auto-Discovery:** Automations automatically detect all station dropdowns matching `input_select.assembly_station_<X>_load_<Y>_part` and push the selected part's weight to the corresponding ESP32 entity (`number.station_<X>_assembly_station_<X>_load_<Y>_average_part_weight`).

### 4. Real-Time BOM Part Tracking & Quality Check Rig
* **Bin-to-Artifact Part Tracking:** As an artifact enters an assembly station, Home Assistant snapshots the station's 8 load cell item counts and tracks the net consumption delta ($\Delta = \text{Initial Count} - \text{Current Count}$) for every assigned part name against the required Bill of Materials (BOM).
* **Sliding-Window RPM Verification:** Evaluates the artifact's RPM sensor during spin testing. To prevent defective parts (such as an artifact with extra slots whose average RPM climbs through the target band) from triggering a false positive, the binary sensor requires at least **2 consecutive sliding-window updates** strictly inside `[min_rpm, max_rpm]` and immediately revokes the pass if the RPM overshoots `max_rpm`.
* **Stepper Audio Feedback:** Triggers `rest_command.stepper_play_fur_elise` to play *Für Elise* by modulating stepper pulse frequencies upon passing inspection.

---

## Prerequisites

1. **Home Assistant OS / Supervised / Container** (2024.4 or newer recommended).
2. **ESPHome Integration & Add-on** for compiling and OTA-flashing station and artifact nodes.
3. **MQTT Broker** (e.g., Mosquitto Add-on) configured in both Home Assistant and ESPHome `secrets.yaml` for the `100ms` telemetry stream.
4. **HACS (Home Assistant Community Store)** with the following frontend card installed:
   * [**button-card**](https://github.com/custom-cards/button-card) (`custom:button-card` — required for the `#BA0C2F` bucket KPI headers and Quality Check HUD).

---

## Step-by-Step Installation Guide

### Step 1: Copy Repository Files to Home Assistant
Copy the contents of the `homeassistant/` directory in this repository directly into your Home Assistant `/config/` directory so that `custom_templates/`, `packages/`, `www/`, and `esphome/` merge into `/config/`.

Verify that `/config/configuration.yaml` includes the package loader at the top level (ensure there is **no colon** after `!include_dir_named`):

```yaml
homeassistant:
  packages: !include_dir_named packages
```

### Step 2: Register the 3D IMU Visualizer Frontend Resource
To allow Home Assistant to render the custom 3D WebGL card (`www/imu-visualizer.js`) and load the 3D model (`www/artifact.glb`):

1. In Home Assistant, navigate to **Settings** $\rightarrow$ **Dashboards**.
2. Click the **Three Dots ($\vdots$)** menu in the top-right corner and select **Resources**.
3. Click **Add Resource** and enter:
   * **URL:** `/local/imu-visualizer.js`
   * **Resource Type:** `JavaScript Module`
4. Click **Create** and refresh your browser cache.

### Step 3: Configure Secrets & Flash ESPHome Nodes
Ensure your `/config/esphome/secrets.yaml` defines your Wi-Fi, OTA, API, and MQTT credentials:

```yaml
wifi_ssid: "YOUR_WIFI_SSID"
wifi_password: "YOUR_WIFI_PASSWORD"
mqtt_broker: "192.168.1.XXX"
mqtt_user: "YOUR_MQTT_USER"
mqtt_password: "YOUR_MQTT_PASSWORD"
```

1. Open the **ESPHome Dashboard** in Home Assistant.
2. Compile and flash your station nodes (`assembly-station-1.yaml`, etc.) and smart artifact nodes (`assembly-01.yaml`).
3. Once online, navigate to **Settings** $\rightarrow$ **Devices & Services** $\rightarrow$ **ESPHome** to confirm each station and artifact is discovered by Home Assistant.

### Step 4: Reload Home Assistant Backend & Import Dashboards
1. Go to **Developer Tools** $\rightarrow$ **YAML**, click **Check Configuration**, and restart Home Assistant to initialize the `parts_catalog.yaml` package and `artifact_tracking.jinja` macros.
2. To deploy the full assembly line dashboard:
   * Create a new dashboard under **Settings** $\rightarrow$ **Dashboards** $\rightarrow$ **Add Dashboard**.
   * Open the new dashboard, click **Edit** (pencil icon) $\rightarrow$ **Three Dots ($\vdots$)** $\rightarrow$ **Raw configuration editor**.
   * Paste the contents of `dashboards/full-assy-line-dashboard.yaml` and click **Save**.
3. Alternatively, individual cards (`imu-visualizer.yaml`, `parts-catalog.yaml`, `quality-control-card.yaml`) can be added to any existing view via **Add Card** $\rightarrow$ **Manual**.

---

## Standard Operating Procedures (SOP)

### 1. Managing the Master Parts Catalog
All part weights are managed centrally from the **Parts Catalog** card (`dashboards/parts-catalog.yaml`):
* **Add a New Part:** Enter the part name into **1. Enter Part Name**, enter the single-piece weight (in grams) into **2. Enter Single Part Weight (g)**, and click **SAVE PART**. The part immediately appears in the catalog table and populates into all station bin dropdowns.
* **Update an Existing Part's Weight:** Enter the **exact existing name** of the part into **1. Enter Part Name**, enter the updated weight into **2. Enter Single Part Weight (g)**, and click **SAVE PART**. Every station bin currently assigned to that part will automatically receive the updated weight within milliseconds.
* **Delete a Part:** Enter the exact part name into **1. Enter Part Name** and click **DELETE**.
* **Assign a Part to a Bucket:** Select the part from the **Part** dropdown directly underneath any bucket's `#BA0C2F` KPI card. The active part name and unit weight badge in the top-right corner of the card will update immediately.

### 2. Taring & Calibrating a Load Cell Bucket
* **Zero / Tare:** Empty the bucket completely and click **Tare** underneath that bucket's KPI card.
* **Adjust Calibration Reference Mass:** **Press and hold (`hold_action`)** on the **Calibrate** button to open the `Calibration Mass` input popup (default `500 g`).
* **Calibrate Known Mass:** Place your reference calibration weight into the empty, tared bucket, wait 1 second for the reading to settle, and **tap** **Calibrate**.

### 3. Operating the Quality Verification Rig
* Set the target test speed in **Target Stepper RPM** (`input_number.stepper_rpm`).
* Click **START QUALITY TEST** to trigger `rest_command.quality_test`.
* The HUD card (`binary_sensor.artifact_prototype_quality_check_passed`) will display **WAITING TO PASS QUALITY** (pulsing amber) until at least 2 consecutive sliding-window RPM readings stabilize inside the target range without overshooting, at which point it transitions to **PASSED QUALITY CHECK** (glowing neon green).
* Click **EMERGENCY STOP** at any time to halt the stepper motor via `rest_command.stepper_stop`.

---

## Scaling the Testbed

### Adding a New Assembly Station (e.g., Station 4)
1. **Create the ESPHome Node:** Duplicate `esphome/assembly-station-1.yaml` as `esphome/assembly-station-4.yaml` and update the node name and substitutions:
   ```yaml
   esphome:
     name: "assembly-station-4"
     friendly_name: Assembly Station 4

   substitutions:
     station_id: "04"
     station_num: "4"

   packages:
     station_common: !include common/assembly_station_config.yaml
   ```
2. **Add Station Dropdown Helpers:** Open `packages/parts_catalog.yaml` and duplicate the 8 `input_select` lines under `input_select:`, changing `_3_` (or `_1_`) to `_4_` (`assembly_station_4_load_1_part` through `assembly_station_4_load_8_part`).
3. **Hot-Reload:** In Home Assistant, go to **Developer Tools** $\rightarrow$ **YAML** and click **Input Selects**. The regex auto-discovery automations (`^assembly_station_\d+_load_\d+_part$`) will automatically detect Station 4 and sync all 8 load cells without any automation edits.

---

## Tunable Parameters & Engineering Reference

### 1. Load Cell DSP Parameters (`esphome/common/load_cell_template.yaml`)

| Parameter / Variable | Location | Default | Description & Tuning Guidance |
| :--- | :--- | :--- | :--- |
| `gain` | `sensor.hx711` | `128` | HX711 Channel A PGA gain (`128` or `64`). `128` provides 1 extra bit of noise-free resolution. Recalibrate after changing. |
| `window_size` | `sensor.hx711` $\rightarrow$ `median` | `9` | Number of raw samples in the median filter. Rejects up to $\frac{N-1}{2}$ consecutive corrupted samples (`400ms` at `100ms` polling). |
| `diff > 1.2` | `load${num}_mass` lambda | `1.2` ($\text{g}$) | Step-detection threshold. Lower to `0.4` if measuring micro-parts under $0.8\text{ g}$; increase to `2.5` in high-vibration environments. |
| `step_confirm_count >= 3` | `load${num}_mass` lambda | `3` (ticks) | Number of consecutive `100ms` ticks a weight jump must persist to trigger fast Kalman response. |
| `q` (Resting / Step) | `load${num}_mass` lambda | `0.0005` / `2.0` | Kalman process noise covariance ($Q$). Lower resting `q` (`0.0001`) for heavier smoothing; increase step `q` for faster jumps. |
| `r` | `load${num}_mass` lambda | `0.5` | Kalman measurement noise covariance ($R$). Increase (e.g., `1.0`) if raw load cell noise is high. |
| `fabs(drift) < 0.45` | `load${num}_mass` lambda | `0.45` ($\text{g}$) | Upper ceiling for thermal drift compensation. Drift smaller than this is slowly zeroed out at $0.5\%$ per tick (`0.005`). |
| `fabs(estimate) < 0.25` | `load${num}_mass` lambda | `0.25` ($\text{g}$) | Empty-bin zero snap threshold. Readings within $\pm 0.25\text{ g}$ of zero report `0.00 g`. |
| `fabs(current_mass - prev_mass) < 0.5` | `l${num}_item_count` lambda | `0.5` ($\text{g}$) | Stability gate threshold. If mass moves by $\ge 0.5\text{ g}$ between `200ms` ticks (hand in bin), the item counter freezes. |
| `stable_ticks >= 4` | `l${num}_item_count` lambda | `4` (ticks) | Settling time ($4 \times 200\text{ ms} = 800\text{ ms}$) required after a hand leaves the bin before the item count updates. |
| `>= 0.60` | `l${num}_item_count` lambda | `0.60` (items) | Fractional hysteresis deadband. Prevents item count from flickering when weight sits near a `0.5` rounding boundary. |

### 2. Quality Check & Artifact Tracking Parameters (`configuration.yaml`)

| Parameter / Variable | Location | Default | Description & Tuning Guidance |
| :--- | :--- | :--- | :--- |
| `min_rpm` / `max_rpm` | `binary_sensor` template | `95.0` / `105.0` | Target RPM pass window. Parts that overshoot `max_rpm` immediately reset `valid_window_samples` to `0` and revoke any latched pass. |
| `(valid_count + 1) >= 2` | `binary_sensor` template | `2` (samples) | Minimum consecutive sliding-window averages inside `[min_rpm, max_rpm]` required to pass quality check. |
| `required_bom` | `sensor.artifact_installed_parts_tracker` | Dictionary | Target BOM dictionary mapping part names from `sensor.master_parts_catalog` to required integer quantities. |

---

## Hardware Best Practices

* **Power Supply Decoupling:** Solder a $10\text{ }\mu\text{F}$ to $100\text{ }\mu\text{F}$ electrolytic capacitor in parallel with a $0.1\text{ }\mu\text{F}$ ceramic capacitor across `VCC` and `GND` at the HX711 power rails to absorb ESP32 `100ms` Wi-Fi current spikes.
* **Airflow & Draft Isolation:** Cover the HX711 IC and its on-board voltage-divider SMD resistors (`R1`/`R2`) with closed-cell foam or Kapton tape to prevent HVAC air currents from creating localized thermal gradients across the reference divider.
* **Analog Ground Tie (`E-` to `GND`):** On green HX711 breakout PCBs, verify continuity between `E-` and `GND` with a multimeter. If isolated, solder a jumper bridge between `E-` and `GND` to eliminate $60\text{ Hz}$ common-mode noise.