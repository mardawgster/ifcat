# Cyber-Physical Assembly Testbed — Home Assistant & ESPHome Architecture

A modular, scalable firmware and Home Assistant backend architecture for a multi-station manual assembly testbed. Each assembly station features **8 independent HX711 load cell bins** with real-time digital signal processing (DSP), dynamic part-weight catalog syncing, high-frequency `100ms` MQTT telemetry logging, real-time artifact part-tracking across stations, and an automated artifact quality verification system.

---

## Repository File Structure (what your Home Assistant file structure should be)

```text
└── homeassistant/
    ├── configuration.yaml                    # Core HA config: enables packages, QC rig logic, stepper REST commands & artifact tracking
    ├── custom_templates/
    │   └── artifact_tracking.jinja           # Reusable Jinja2 macros for station part-consumption & BOM verification
    ├── packages/
    │   └── parts_catalog.yaml                # Self-contained Master Parts DB, scripts, dropdowns & auto-discovery automations
    ├── dashboards/
    │   ├── master_load_cell_stations.yaml    # Lovelace YAML: Master Parts Table, button_card_templates & 8-Bin Station Views
    │   └── quality_check_card.yaml           # Lovelace YAML: Quality Check HUD graphic & tactile Quality Controls card
    └── esphome/
        ├── assembly-station-1.yaml           # Station 1 node definition (substitutions, Wi-Fi/OTA, includes common config)
        ├── assembly-station-2.yaml           # Station 2 node definition
        ├── assembly-station-3.yaml           # Station 3 node definition
        ├── artifact-node-1.yaml              # Smart artifact ESP node definition (includes artifact_config.yaml)
        └── common/
            ├── assembly_station_config.yaml  # Shared station config: 8x load_cell_template includes & 100ms MQTT telemetry
            ├── load_cell_template.yaml       # Parameterized single load-cell DSP, Kalman filter & calibration template
            └── artifact_config.yaml          # Shared smart artifact config (IMU motion gates, BLE/station tracking, RPM telemetry)
```

---

## Key Features & System Architecture

### 1. Multi-Stage Load Cell DSP Pipeline (`esphome/common/load_cell_template.yaml`)
Raw HX711 load cell readings are susceptible to ESP32 Wi-Fi current dips, bit-bang timing interrupts, ambient temperature drift, and operator hand pressure. Each load cell runs a 4-stage real-time filter pipeline on the ESP32:
* **Staggered Polling & Spike Rejection (`load_raw`):** The 8 HX711 sensors per station are polled at staggered intervals (`93ms` to `107ms`) to prevent CPU lockups during `100ms` MQTT broadcasts. A 9-sample moving median filter completely discards momentary bit-shift glitches up to `400ms` long.
* **Adaptive 1D Kalman Filter (`load_mass`):** Dynamically switches process noise covariance ($Q$) between ultra-smooth resting tracking ($Q = 0.0005$) and instantaneous step response ($Q = 2.0$) when a weight change $> 1.2\text{ g}$ is confirmed for 3 consecutive ticks (`300ms`).
* **Flash-Safe Continuous Thermal & Creep Compensation:** Tracks an internal `thermal_anchor` in RAM. Slow, sub-$0.45\text{ g}$ ambient temperature drift and mechanical strain-gauge creep are bled off at $0.5\%$ per tick without writing to ESP32 NVS flash memory—preserving flash lifespan while keeping bins zeroed across HVAC swings.
* **"Hand-in-Bin" Stability Gate & Fractional Hysteresis (`l_item_count`):** Prevents false item-count spikes when an operator reaches into a bin. The item counter freezes whenever the bin weight is actively changing ($\Delta m \ge 0.5\text{ g}$) and only updates after the scale settles for 4 consecutive ticks (`800ms`), using a $\pm 0.60\text{ item}$ deadband to eliminate rounding flicker.

### 2. Dynamic Master Parts Catalog (`packages/parts_catalog.yaml`)
* **Zero-Reflash Part Management:** Operators can add, edit, or delete parts and their average unit weights directly from the Home Assistant dashboard UI.
* **Persistent Event-Driven Database:** Stored inside a trigger-based template sensor (`sensor.master_parts_catalog`) that survives Home Assistant reboots.
* **Regex Auto-Discovery:** Home Assistant automations automatically detect all station dropdowns matching `input_select.assembly_station_<X>_load_<Y>_part` and push the selected part's weight to the corresponding ESP32 entity (`number.station_<X>_assembly_station_<X>_load_<Y>_average_part_weight`).

### 3. Real-Time Artifact Part Tracking & Quality Check (`configuration.yaml` & `artifact_tracking.jinja`)
* **Bin-to-Artifact Part Tracking:** As an artifact moves through an assembly station, Home Assistant snapshots the station's 8 load cell item counts upon arrival and tracks the exact delta ($\Delta = \text{Initial Count} - \text{Current Count}$) for every assigned part name, verifying against the required Bill of Materials (BOM).
* **Sliding-Window Quality Assessment:** Evaluates the artifact's RPM sensor directly in `configuration.yaml`. To prevent parts with extra slots from falsely triggering a pass as their sliding-window average climbs through the target band, the sensor requires at least **2 consecutive sliding-window updates** inside `[MIN_RPM, MAX_RPM]` and immediately revokes the pass if the RPM overshoots `MAX_RPM`.
* **Quality Controls & Stepper Audio Feedback:** Includes REST commands for initiating the quality test (`rest_command.quality_test`), triggering an emergency stop (`rest_command.stepper_stop`), and playing *Für Elise* on the stepper motor (`rest_command.stepper_play_fur_elise`).

---

## Complete Implementation Code

### 1. ESPHome Load Cell Template (`homeassistant/esphome/common/load_cell_template.yaml`)

```yaml
# homeassistant/esphome/common/load_cell_template.yaml
# Required vars: num ("1".."8"), dout_pin, clk_pin, update_ms ("93ms".."107ms")

globals:
  - id: load${num}_calibration_factor
    type: float
    restore_value: yes
    initial_value: '1.0'

  - id: load${num}_tare_value
    type: float
    restore_value: yes
    initial_value: '0.0'

number:
  - platform: template
    name: "Load ${num} Calibration Mass"
    id: load${num}_calib_mass
    optimistic: yes
    restore_value: yes
    initial_value: 500
    min_value: 1
    max_value: 20000
    step: 0.1
    unit_of_measurement: 'g'

  - platform: template
    name: "Load ${num} Average Part Weight"
    id: load${num}_avg_part_weight
    optimistic: yes
    restore_value: yes
    initial_value: 1.0
    min_value: 0.01
    max_value: 5000
    step: 0.01
    mode: box
    unit_of_measurement: 'g'

button:
  - platform: template
    name: "Load ${num} Tare"
    on_press:
      - lambda: |-
          id(load${num}_tare_value) = id(load${num}_raw).state;
          ESP_LOGD("main", "Load ${num} New Tare Value set to: %.2f", id(load${num}_tare_value));

  - platform: template
    name: "Load ${num} Calibrate Known Mass"
    on_press:
      - lambda: |-
          float raw_value = id(load${num}_raw).state;
          float known_mass = id(load${num}_calib_mass).state;
          if (known_mass != 0.0) {
            id(load${num}_calibration_factor) = (raw_value - id(load${num}_tare_value)) / known_mass;
            ESP_LOGD("main", "Load ${num} New Calibration Factor set to: %.4f", id(load${num}_calibration_factor));
          } else {
            ESP_LOGE("main", "Cannot calibrate Load ${num} with a mass of 0.");
          }

sensor:
  - platform: hx711
    name: "Load ${num} Raw Value"
    dout_pin: ${dout_pin}
    clk_pin: ${clk_pin}
    gain: 128
    update_interval: ${update_ms}
    id: load${num}_raw
    internal: True
    filters:
      - median:
          window_size: 9
          send_every: 1

  - platform: template
    name: "Load ${num} Mass"
    id: load${num}_mass
    icon: "mdi:scale-bathroom"
    unit_of_measurement: 'g'
    accuracy_decimals: 2
    update_interval: 100ms
    lambda: |-
      float raw = id(load${num}_raw).state;
      float factor = id(load${num}_calibration_factor);
      if (factor == 0.0 || isnan(raw)) return 0.0;

      static float estimate = 0.0;
      static float err_estimate = 1.0;
      static float thermal_anchor = 0.0;
      static float thermal_offset_grams = 0.0;
      static float last_tare_value = 0.0;
      static int step_confirm_count = 0;
      static bool initialized = false;

      if (id(load${num}_tare_value) != last_tare_value) {
        thermal_offset_grams = 0.0;
        last_tare_value = id(load${num}_tare_value);
        initialized = false;
      }

      float measured_mass = ((raw - id(load${num}_tare_value)) / factor) - thermal_offset_grams;

      if (measured_mass > 10000.0 || measured_mass < -500.0) {
        return id(load${num}_mass).state;
      }

      if (!initialized) {
        estimate = measured_mass;
        thermal_anchor = measured_mass;
        initialized = true;
        return estimate;
      }

      float diff = fabs(measured_mass - estimate);

      if (diff > 1.2) {
        step_confirm_count++;
      } else {
        step_confirm_count = 0;
      }

      float q = (step_confirm_count >= 3) ? 2.0 : 0.0005;
      float r = 0.5;

      if (diff <= 1.2 || step_confirm_count >= 3) {
        err_estimate += q;
        float kalman_gain = err_estimate / (err_estimate + r);
        estimate = estimate + kalman_gain * (measured_mass - estimate);
        err_estimate = (1.0 - kalman_gain) * err_estimate;
      }

      if (step_confirm_count >= 3 || fabs(estimate - thermal_anchor) >= 0.75) {
        thermal_anchor = estimate;
      } else {
        float drift = estimate - thermal_anchor;
        if (step_confirm_count == 0 && fabs(drift) > 0.02 && fabs(drift) < 0.45) {
          float correction = drift * 0.005;
          thermal_offset_grams += correction;
          estimate -= correction;
        }
      }

      if (fabs(estimate) < 0.25) {
        return 0.0;
      }

      return estimate;

  - platform: template
    name: "Load ${num} Item Count"
    id: l${num}_item_count
    icon: "mdi:counter"
    unit_of_measurement: 'items'
    accuracy_decimals: 0
    update_interval: 200ms
    lambda: |-
      float current_mass = id(load${num}_mass).state;
      float item_weight = id(load${num}_avg_part_weight).state;
      if (item_weight <= 0.0 || isnan(item_weight) || isnan(current_mass)) {
        return 0.0;
      }

      static float prev_mass = 0.0;
      static int stable_ticks = 0;
      static int locked_count = 0;

      if (fabs(current_mass - prev_mass) < 0.5) {
        stable_ticks++;
      } else {
        stable_ticks = 0;
      }
      prev_mass = current_mass;

      if (stable_ticks >= 4) {
        float exact_items = current_mass / item_weight;
        if (fabs(exact_items - (float)locked_count) >= 0.60) {
          locked_count = round(exact_items);
        }
      }

      if (locked_count < 0) locked_count = 0;
      return locked_count;
    filters:
      - clamp:
          min_value: 0
          max_value: 200
          ignore_out_of_range: True
```

---

### 2. Shared Station Config (`homeassistant/esphome/common/assembly_station_config.yaml`)

```yaml
# homeassistant/esphome/common/assembly_station_config.yaml
# Included by each assembly-station-X.yaml file

packages:
  load_cell_1: !include
    file: load_cell_template.yaml
    vars:
      num: "1"
      dout_pin: "21"
      clk_pin: "19"
      update_ms: "93ms"

  load_cell_2: !include
    file: load_cell_template.yaml
    vars:
      num: "2"
      dout_pin: "23" # <-- Replace with Load 2 DOUT pin
      clk_pin: "22"  # <-- Replace with Load 2 CLK pin
      update_ms: "95ms"

  load_cell_3: !include
    file: load_cell_template.yaml
    vars:
      num: "3"
      dout_pin: "26" # <-- Replace with Load 3 DOUT pin
      clk_pin: "25"  # <-- Replace with Load 3 CLK pin
      update_ms: "97ms"

  load_cell_4: !include
    file: load_cell_template.yaml
    vars:
      num: "4"
      dout_pin: "5" # <-- Replace with Load 4 DOUT pin
      clk_pin: "4"  # <-- Replace with Load 4 CLK pin
      update_ms: "99ms"

  load_cell_5: !include
    file: load_cell_template.yaml
    vars:
      num: "5"
      dout_pin: "13" # <-- Replace with Load 5 DOUT pin
      clk_pin: "12"  # <-- Replace with Load 5 CLK pin
      update_ms: "101ms"

  load_cell_6: !include
    file: load_cell_template.yaml
    vars:
      num: "6"
      dout_pin: "15" # <-- Replace with Load 6 DOUT pin
      clk_pin: "14"  # <-- Replace with Load 6 CLK pin
      update_ms: "103ms"

  load_cell_7: !include
    file: load_cell_template.yaml
    vars:
      num: "7"
      dout_pin: "17" # <-- Replace with Load 7 DOUT pin
      clk_pin: "16"  # <-- Replace with Load 7 CLK pin
      update_ms: "105ms"

  load_cell_8: !include
    file: load_cell_template.yaml
    vars:
      num: "8"
      dout_pin: "32"  # <-- Replace with Load 8 DOUT pin
      clk_pin: "27" # <-- Replace with Load 8 CLK pin
      update_ms: "107ms"

# High-Frequency 100ms MQTT Telemetry Broadcast
interval:
  - interval: 100ms
    then:
      - if:
          condition:
            lambda: 'return id(sntp_time).now().is_valid();'
          then:
            - mqtt.publish_json:
                topic: !lambda 'return "testbed/telemetry/" + App.get_name();'
                payload: |-
                  struct timeval tv;
                  gettimeofday(&tv, NULL);
                  uint64_t ts_ms = (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
                  
                  root["timestamp"] = ts_ms;
                  root["device"] = App.get_name();
                  
                  root["load1_mass"] = id(load1_mass).has_state() ? id(load1_mass).state : 0.0;
                  root["load2_mass"] = id(load2_mass).has_state() ? id(load2_mass).state : 0.0;
                  root["load3_mass"] = id(load3_mass).has_state() ? id(load3_mass).state : 0.0;
                  root["load4_mass"] = id(load4_mass).has_state() ? id(load4_mass).state : 0.0;
                  root["load5_mass"] = id(load5_mass).has_state() ? id(load5_mass).state : 0.0;
                  root["load6_mass"] = id(load6_mass).has_state() ? id(load6_mass).state : 0.0;
                  root["load7_mass"] = id(load7_mass).has_state() ? id(load7_mass).state : 0.0;
                  root["load8_mass"] = id(load8_mass).has_state() ? id(load8_mass).state : 0.0;
                  
                  root["load1_count"] = id(l1_item_count).has_state() ? id(l1_item_count).state : 0.0;
                  root["load2_count"] = id(l2_item_count).has_state() ? id(l2_item_count).state : 0.0;
                  root["load3_count"] = id(l3_item_count).has_state() ? id(l3_item_count).state : 0.0;
                  root["load4_count"] = id(l4_item_count).has_state() ? id(l4_item_count).state : 0.0;
                  root["load5_count"] = id(l5_item_count).has_state() ? id(l5_item_count).state : 0.0;
                  root["load6_count"] = id(l6_item_count).has_state() ? id(l6_item_count).state : 0.0;
                  root["load7_count"] = id(l7_item_count).has_state() ? id(l7_item_count).state : 0.0;
                  root["load8_count"] = id(l8_item_count).has_state() ? id(l8_item_count).state : 0.0;
```

---

### 3. Artifact Part Tracking Jinja Macros (`homeassistant/custom_templates/artifact_tracking.jinja`)

```jinja2
{# homeassistant/custom_templates/artifact_tracking.jinja #}

{# Returns a JSON dictionary of current item counts per assigned part across all 8 bins of a station #}
{% macro station_part_inventory(station_num) %}
  {% set ns = namespace(parts={}) %}
  {% for bin in range(1, 9) %}
    {% set part_entity = 'input_select.assembly_station_' ~ station_num ~ '_load_' ~ bin ~ '_part' %}
    {% set count_entity = 'sensor.assembly_station_' ~ station_num ~ '_load_' ~ bin ~ '_item_count' %}
    {% set part_name = states(part_entity) %}
    {% set count_val = states(count_entity) | int(0) %}
    {% if part_name not in ['unknown', 'unavailable', 'Unassigned', 'None', ''] %}
      {% set existing = ns.parts.get(part_name, 0) %}
      {% set ns.parts = dict(ns.parts, **{part_name: existing + count_val}) %}
    {% endif %}
  {% endfor %}
  {{ ns.parts | to_json }}
{% endmacro %}

{# Calculates parts consumed (picked) from a station since the artifact entered the station #}
{% macro station_parts_picked(station_num, baseline_dict) %}
  {% set current_inv = station_part_inventory(station_num) | from_json %}
  {% set ns = namespace(picked={}) %}
  {% for part, start_count in baseline_dict.items() %}
    {% set now_count = current_inv.get(part, 0) | int(0) %}
    {% set delta = (start_count | int(0)) - now_count %}
    {# Positive delta means items were removed from the bin and installed on the artifact #}
    {% set ns.picked = dict(ns.picked, **{part: [delta, 0] | max}) %}
  {% endfor %}
  {{ ns.picked | to_json }}
{% endmacro %}

{# Checks if the artifact's accumulated parts match the required Bill of Materials (BOM) dictionary #}
{% macro verify_artifact_bom(installed_parts_dict, required_bom_dict) %}
  {% set ns = namespace(passed=true, missing={}) %}
  {% for req_part, req_qty in required_bom_dict.items() %}
    {% set actual_qty = installed_parts_dict.get(req_part, 0) | int(0) %}
    {% if actual_qty != (req_qty | int(0)) %}
      {% set ns.passed = false %}
      {% set ns.missing = dict(ns.missing, **{req_part: (req_qty | int(0)) - actual_qty}) %}
    {% endif %}
  {% endfor %}
  {{ {'bom_passed': ns.passed, 'discrepancies': ns.missing} | to_json }}
{% endmacro %}
```

---

### 4. Home Assistant Core Configuration (`homeassistant/configuration.yaml`)

```yaml
# homeassistant/configuration.yaml

homeassistant:
  packages: !include_dir_named packages

input_number:
  stepper_rpm:
    name: "Target Stepper RPM"
    min: 0
    max: 300
    step: 1
    mode: box
    unit_of_measurement: "RPM"

# ==========================================================
# 1. QUALITY RIG & STEPPER MOTOR REST COMMANDS
# ==========================================================
rest_command:
  quality_test:
    url: "http://YOUR_STEPPER_CONTROLLER_IP/api/stepper/start_test"
    method: POST
    headers:
      Content-Type: "application/json"
    payload: '{"rpm": {{ states("input_number.stepper_rpm") | float(100) }}}'

  stepper_stop:
    url: "http://YOUR_STEPPER_CONTROLLER_IP/api/stepper/stop"
    method: POST

  stepper_play_fur_elise:
    url: "http://YOUR_STEPPER_CONTROLLER_IP/api/stepper/play"
    method: POST
    headers:
      Content-Type: "application/json"
    payload: >
      {
        "song": "Fur Elise",
        "notes": [
          {"note": "E5",  "freq": 659, "duration_ms": 200},
          {"note": "DS5", "freq": 622, "duration_ms": 200},
          {"note": "E5",  "freq": 659, "duration_ms": 200},
          {"note": "DS5", "freq": 622, "duration_ms": 200},
          {"note": "E5",  "freq": 659, "duration_ms": 200},
          {"note": "B4",  "freq": 494, "duration_ms": 200},
          {"note": "D5",  "freq": 587, "duration_ms": 200},
          {"note": "C5",  "freq": 523, "duration_ms": 200},
          {"note": "A4",  "freq": 440, "duration_ms": 400},
          {"note": "REST","freq": 0,   "duration_ms": 200},
          {"note": "C4",  "freq": 262, "duration_ms": 200},
          {"note": "E4",  "freq": 330, "duration_ms": 200},
          {"note": "A4",  "freq": 440, "duration_ms": 200},
          {"note": "B4",  "freq": 494, "duration_ms": 400},
          {"note": "REST","freq": 0,   "duration_ms": 200},
          {"note": "E4",  "freq": 330, "duration_ms": 200},
          {"note": "GS4", "freq": 415, "duration_ms": 200},
          {"note": "B4",  "freq": 494, "duration_ms": 200},
          {"note": "C5",  "freq": 523, "duration_ms": 400}
        ]
      }

# ==========================================================
# 2. ARTIFACT QUALITY RIG & PART TRACKING SENSORS
# ==========================================================
template:
  # --- QUALITY RIG SLIDING WINDOW RPM VERIFICATION ---
  # Waits for at least 2 sliding-window updates inside [MIN_RPM, MAX_RPM]
  # so parts with extra slots that climb past the target window do not trigger a false pass.
  - trigger:
      - platform: state
        entity_id: sensor.artifact_rpm
    binary_sensor:
      - name: "Artifact Prototype Quality Check Passed"
        unique_id: artifact_prototype_quality_check_passed
        icon: >
          {{ 'mdi:check-decagram' if this.state == 'on' else 'mdi:timer-sand' }}
        state: >
          {% set rpm = states('sensor.artifact_rpm') | float(0) %}
          {% set min_rpm = 95.0 %}
          {% set max_rpm = 105.0 %}
          {% set valid_count = this.attributes.get('valid_window_samples', 0) | int(0) %}
          {% set latched = this.state == 'on' %}
          {% if rpm < 5.0 %}
            false
          {% elif min_rpm <= rpm <= max_rpm %}
            {{ true if (valid_count + 1) >= 2 else false }}
          {% elif rpm > max_rpm %}
            false
          {% else %}
            {{ latched }}
          {% endif %}
        attributes:
          valid_window_samples: >
            {% set rpm = states('sensor.artifact_rpm') | float(0) %}
            {% set min_rpm = 95.0 %}
            {% set max_rpm = 105.0 %}
            {% set prev = this.attributes.get('valid_window_samples', 0) | int(0) %}
            {% if min_rpm <= rpm <= max_rpm %}
              {{ prev + 1 }}
            {% else %}
              0
            {% endif %}

  # --- ARTIFACT PART TRACKING & BOM SENSOR ---
  - trigger:
      - platform: event
        event_type: artifact_station_event
      - platform: state
        entity_id:
          - sensor.assembly_station_3_load_1_item_count
          - sensor.assembly_station_3_load_2_item_count
          - sensor.assembly_station_3_load_3_item_count
          - sensor.assembly_station_3_load_4_item_count
          - sensor.assembly_station_3_load_5_item_count
          - sensor.assembly_station_3_load_6_item_count
          - sensor.assembly_station_3_load_7_item_count
          - sensor.assembly_station_3_load_8_item_count
    sensor:
      - name: "Artifact Installed Parts Tracker"
        unique_id: artifact_installed_parts_tracker
        icon: mdi:clipboard-list-outline
        state: >
          {% from 'artifact_tracking.jinja' import verify_artifact_bom %}
          {% set installed = this.attributes.get('installed_parts', {}) %}
          {% set required_bom = this.attributes.get('required_bom', {'M3 Bolt': 4, '10mm Spacer': 2, 'Gear Housing': 1}) %}
          {% set check = verify_artifact_bom(installed, required_bom) | from_json %}
          {{ 'BOM Complete' if check.bom_passed else 'In Progress' }}
        attributes:
          active_station: >
            {% if trigger.platform == 'event' and trigger.event.data.action == 'enter_station' %}
              {{ trigger.event.data.station_num | int(3) }}
            {% else %}
              {{ this.attributes.get('active_station', 3) }}
            {% endif %}
          station_baseline: >
            {% from 'artifact_tracking.jinja' import station_part_inventory %}
            {% if trigger.platform == 'event' and trigger.event.data.action == 'enter_station' %}
              {{ station_part_inventory(trigger.event.data.station_num) | from_json }}
            {% elif trigger.platform == 'event' and trigger.event.data.action == 'reset_artifact' %}
              {{ station_part_inventory(3) | from_json }}
            {% else %}
              {{ this.attributes.get('station_baseline', {}) }}
            {% endif %}
          installed_parts: >
            {% from 'artifact_tracking.jinja' import station_parts_picked %}
            {% if trigger.platform == 'event' and trigger.event.data.action == 'reset_artifact' %}
              {{ {} }}
            {% else %}
              {% set st = this.attributes.get('active_station', 3) %}
              {% set base = this.attributes.get('station_baseline', {}) %}
              {{ station_parts_picked(st, base) | from_json }}
            {% endif %}
          required_bom: >
            {{ this.attributes.get('required_bom', {'M3 Bolt': 4, '10mm Spacer': 2, 'Gear Housing': 1}) }}
```

---

### 5. Master Parts Catalog Package (`homeassistant/packages/parts_catalog.yaml`)

```yaml
# homeassistant/packages/parts_catalog.yaml

input_text:
  catalog_part_name:
    name: "Part Name"
    max: 50
    icon: mdi:tag-text-outline

input_number:
  catalog_part_weight:
    name: "Part Weight (g)"
    min: 0.01
    max: 5000
    step: 0.01
    mode: box
    unit_of_measurement: "g"
    icon: mdi:weight-gram

input_select:
  # --- ASSEMBLY STATION 3 (Duplicate and rename _3_ to _1_, _2_, etc. for all stations) ---
  assembly_station_3_load_1_part: { name: "Station 3 - Load 1 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_2_part: { name: "Station 3 - Load 2 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_3_part: { name: "Station 3 - Load 3 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_4_part: { name: "Station 3 - Load 4 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_5_part: { name: "Station 3 - Load 5 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_6_part: { name: "Station 3 - Load 6 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_7_part: { name: "Station 3 - Load 7 Part", options: ["Unassigned"], icon: mdi:package-variant }
  assembly_station_3_load_8_part: { name: "Station 3 - Load 8 Part", options: ["Unassigned"], icon: mdi:package-variant }

template:
  - trigger:
      - platform: event
        event_type: update_parts_catalog
    sensor:
      - name: "Master Parts Catalog"
        unique_id: master_parts_catalog
        icon: mdi:database-outline
        state: "{{ this.attributes.parts | default({}) | count }}"
        attributes:
          parts: >
            {% set current = dict(this.attributes.get('parts', {})) %}
            {% set action = trigger.event.data.action %}
            {% set name = trigger.event.data.name | default('') | trim %}
            {% if action == 'set' and name != '' and name != 'Unassigned' %}
              {% set weight = trigger.event.data.weight | float(1.0) | round(2) %}
              {{ dict(current, **{name: weight}) }}
            {% elif action == 'delete' and name in current %}
              {% set ns = namespace(d={}) %}
              {% for k, v in current.items() if k != name %}
                {% set ns.d = dict(ns.d, **{k: v}) %}
              {% endfor %}
              {{ ns.d }}
            {% else %}
              {{ current }}
            {% endif %}

script:
  catalog_add_or_update_part:
    alias: "Catalog - Save or Update Part"
    sequence:
      - event: update_parts_catalog
        event_data:
          action: "set"
          name: "{{ states('input_text.catalog_part_name') }}"
          weight: "{{ states('input_number.catalog_part_weight') }}"

  catalog_delete_part:
    alias: "Catalog - Delete Part"
    sequence:
      - event: update_parts_catalog
        event_data:
          action: "delete"
          name: "{{ states('input_text.catalog_part_name') }}"

automation:
  - id: catalog_sync_all_station_dropdowns
    alias: "Catalog - Sync Dropdown Options Across All Stations"
    mode: restart
    trigger:
      - platform: state
        entity_id: sensor.master_parts_catalog
      - platform: homeassistant
        event: start
    action:
      - variables:
          parts_dict: "{{ state_attr('sensor.master_parts_catalog', 'parts') or {} }}"
          options_list: "{{ ['Unassigned'] + (parts_dict.keys() | list | sort) }}"
          all_station_dropdowns: >
            {{ states.input_select
               | selectattr('object_id', 'match', '^assembly_station_\d+_load_\d+_part$')
               | map(attribute='entity_id')
               | list }}
      - repeat:
          for_each: "{{ all_station_dropdowns }}"
          sequence:
            - variables:
                current_choice: "{{ states(repeat.item) }}"
            - action: input_select.set_options
              target:
                entity_id: "{{ repeat.item }}"
              data:
                options: "{{ options_list }}"
            - if:
                - condition: template
                  value_template: "{{ current_choice in options_list }}"
              then:
                - action: input_select.select_option
                  target:
                    entity_id: "{{ repeat.item }}"
                  data:
                    option: "{{ current_choice }}"

  - id: catalog_push_weights_to_station_esps
    alias: "Catalog - Push Weight to Station ESPs"
    mode: queued
    max: 50
    trigger:
      - platform: event
        event_type: state_changed
    condition:
      - condition: template
        value_template: >
          {{ trigger.event.data.entity_id == 'sensor.master_parts_catalog' or
             (trigger.event.data.entity_id.startswith('input_select.assembly_station_') and
              trigger.event.data.entity_id.endswith('_part')) }}
    action:
      - variables:
          parts_dict: "{{ state_attr('sensor.master_parts_catalog', 'parts') or {} }}"
          target_dropdowns: >
            {% if trigger.event.data.entity_id == 'sensor.master_parts_catalog' %}
              {{ states.input_select
                 | selectattr('object_id', 'match', '^assembly_station_\d+_load_\d+_part$')
                 | map(attribute='entity_id')
                 | list }}
            {% else %}
              {{ [trigger.event.data.entity_id] }}
            {% endif %}
      - repeat:
          for_each: "{{ target_dropdowns }}"
          sequence:
            - variables:
                dropdown_id: "{{ repeat.item }}"
                selected_part: "{{ states(dropdown_id) }}"
                station_num: "{{ dropdown_id.split('_')[3] }}"
                esp_number_id: >
                  {{ dropdown_id
                     | replace('input_select.', 'number.station_' ~ station_num ~ '_')
                     | replace('_part', '_average_part_weight') }}
            - if:
                - condition: template
                  value_template: "{{ selected_part in parts_dict and states(esp_number_id) not in ['unavailable', 'unknown'] }}"
              then:
                - action: number.set_value
                  target:
                    entity_id: "{{ esp_number_id }}"
                  data:
                    value: "{{ parts_dict[selected_part] }}"
```

---

### 6. Dashboard Configurations (`homeassistant/dashboards/`)

#### A. Master Load Cell Station View & Bucket KPI Template (`dashboards/master_load_cell_stations.yaml`)

Paste `button_card_templates:` at the very top of your dashboard's Raw Configuration Editor, and include the Master Parts Manager and Station Views inside `views:`:

```yaml
button_card_templates:
  station_bucket_kpi:
    show_state: false
    show_icon: false
    variables:
      station: 3
      bin: 1
      title: ''
      cycle_entity: ''
    name: "[[[ return variables.title || `BUCKET ${variables.bin}`; ]]]"
    custom_fields:
      part_badge: |
        [[[
          let p_id = `input_select.assembly_station_${variables.station}_load_${variables.bin}_part`;
          let w_id = `number.station_${variables.station}_assembly_station_${variables.station}_load_${variables.bin}_average_part_weight`;
          let p = states[p_id]?.state || 'Unassigned';
          let w = states[w_id]?.state || '0';
          return `${p} (${Number(w).toFixed(2)}g)`;
        ]]]
      count_box: |
        [[[
          return `<div style="font-size: 28px; font-weight: 800; color: #e2e8f0;">${entity.state} <span style="font-size: 12px; font-weight: normal; color: #94a3b8;">pcs</span></div>
                  <div style="font-size: 10px; color: #e2e8f0; text-transform: uppercase;">Item Count</div>`;
        ]]]
      mass_box: |
        [[[
          let m_id = `sensor.assembly_station_${variables.station}_load_${variables.bin}_mass`;
          let m = states[m_id]?.state || '0.0';
          return `<div style="font-size: 20px; font-weight: 700; color: #e2e8f0;">${Number(m).toFixed(1)} <span style="font-size: 12px; font-weight: normal; color: #94a3b8;">g</span></div>
                  <div style="font-size: 10px; color: #e2e8f0; text-transform: uppercase;">Net Mass</div>`;
        ]]]
      cycle_box: |
        [[[
          let c_id = variables.cycle_entity || `sensor.load_${variables.bin}_item_count_cycle_time_2`;
          let c = states[c_id]?.state || '0.0';
          return `<div style="font-size: 20px; font-weight: 700; color: #e2e8f0;">${Number(c).toFixed(1)} <span style="font-size: 12px; font-weight: normal; color: #94a3b8;">s</span></div>
                  <div style="font-size: 10px; color: #e2e8f0; text-transform: uppercase;">Cycle Time</div>`;
        ]]]
    styles:
      card:
        - background-color: '#BA0C2F'
        - border: '1px solid #000000'
        - border-radius: 12px
        - padding: 14px 16px
      grid:
        - grid-template-areas: '"n part_badge part_badge" "count_box mass_box cycle_box"'
        - grid-template-columns: 1.2fr 1fr 1fr
        - grid-template-rows: auto auto
        - row-gap: 12px
      name:
        - justify-self: start
        - font-size: 13px
        - font-weight: bold
        - color: '#FFFFFF'
        - letter-spacing: 1px
      custom_fields:
        part_badge:
          - justify-self: end
          - font-size: 11px
          - font-weight: '600'
          - color: '#00ff88'
          - background: rgba(0, 0, 0, 0.35)
          - padding: 2px 8px
          - border-radius: 6px
        count_box:
          - justify-self: start
          - text-align: left
        mass_box:
          - justify-self: center
          - text-align: center
          - align-self: end
        cycle_box:
          - justify-self: end
          - text-align: right
          - align-self: end

views:
  # ============================================================================
  # VIEW 1: MASTER PARTS CATALOG & ARTIFACT BOM TRACKER
  # ============================================================================
  - title: Parts Catalog
    path: parts-catalog
    icon: mdi:database-edit
    cards:
      - type: vertical-stack
        cards:
          - type: markdown
            title: "Master Parts Catalog"
            content: >
              | Part Name | Average Weight (g) |
              | :--- | ---: |
              {% set parts = state_attr

