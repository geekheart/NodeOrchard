#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <inttypes.h>
#include <fcntl.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"
#include "driver/ledc.h"
#include "driver/i2c_master.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_idf_version.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "soc/soc_caps.h"
#include "sd_pwr_ctrl_by_on_chip_ldo.h"
#include "driver/sdmmc_host.h"
#include "hdk_board_config.h"
#if CONFIG_IDF_TARGET_ESP32P4
#include "hdk_mipi.h"
#include "bridge.h"
#endif

static rmt_channel_handle_t rgb_channel;
static rmt_encoder_handle_t rgb_encoder;
static bool rgb_enabled = true;
static uint8_t result_red = 8, result_green = 8, result_blue = 8;
static i2c_master_bus_handle_t camera_bus;
static i2c_master_dev_handle_t camera_device;
static bool camera_clock_started;

static void event(const char *test, const char *status, const char *detail) {
    printf("HDK %s %s %s\n", test, status, detail ? detail : "");
    fflush(stdout);
}

static esp_err_t pixel(uint8_t red, uint8_t green, uint8_t blue) {
    if (HDK_RGB_PIN < 0 || !HDK_TEST_RGB) return ESP_ERR_NOT_SUPPORTED;
    if (!rgb_channel) {
        rmt_tx_channel_config_t channel = {
            .clk_src = RMT_CLK_SRC_DEFAULT, .gpio_num = HDK_RGB_PIN,
            .mem_block_symbols = 64, .resolution_hz = 10000000,
            .trans_queue_depth = 1,
        };
        esp_err_t e = rmt_new_tx_channel(&channel, &rgb_channel);
        if (e != ESP_OK) return e;
        rmt_bytes_encoder_config_t bytes = {
            .bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9},
            .bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3},
            .flags.msb_first = 1,
        };
        e = rmt_new_bytes_encoder(&bytes, &rgb_encoder);
        if (e != ESP_OK) return e;
        e = rmt_enable(rgb_channel);
        if (e != ESP_OK) return e;
    }
    const uint8_t data[] = {green, red, blue};
    rmt_transmit_config_t transmit = {.loop_count = 0, .flags.eot_level = 0};
    esp_err_t e = rmt_transmit(rgb_channel, rgb_encoder, data, sizeof(data), &transmit);
    if (e == ESP_OK) e = rmt_tx_wait_all_done(rgb_channel, 1000);
    vTaskDelay(pdMS_TO_TICKS(2));  // WS2812 reset latch, output remains low.
    return e;
}

static void rgb_test(void) {
    if (!HDK_TEST_RGB) return;
    bool good = true;
    good &= pixel(8, 0, 0) == ESP_OK; vTaskDelay(pdMS_TO_TICKS(350));
    good &= pixel(0, 8, 0) == ESP_OK; vTaskDelay(pdMS_TO_TICKS(350));
    good &= pixel(0, 0, 8) == ESP_OK; vTaskDelay(pdMS_TO_TICKS(350));
    good &= pixel(0, 0, 0) == ESP_OK;
    event("rgb", good ? "EMITTED" : "FAIL", "operator_must_confirm_red_green_blue_off");
}

static bool sd_test(void) {
    if (!HDK_TEST_SD_CARD) return true;
    sdmmc_card_t *card = NULL;
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.slot = HDK_SD_SLOT;
    host.max_freq_khz = SDMMC_FREQ_DEFAULT;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 4;
#if SOC_SDMMC_USE_GPIO_MATRIX
    slot.clk = HDK_SD_CLK; slot.cmd = HDK_SD_CMD;
    slot.d0 = HDK_SD_D0; slot.d1 = HDK_SD_D1;
    slot.d2 = HDK_SD_D2; slot.d3 = HDK_SD_D3;
#endif
    sd_pwr_ctrl_handle_t sd_power = NULL;
#if CONFIG_IDF_TARGET_ESP32S31
    // S31 SLOT0 IO domain is internally powered; card VDD remains board 3.3V.
    sd_pwr_ctrl_ldo_config_t ldo = {.ldo_chan_id = 1};
    esp_err_t power_e = sd_pwr_ctrl_new_on_chip_ldo(&ldo, &sd_power);
    if (power_e != ESP_OK) { event("sd-card", "FAIL", esp_err_to_name(power_e)); return false; }
    host.pwr_ctrl_handle = sd_power;
    host.io_voltage = 1.8f;
#endif
    esp_vfs_fat_sdmmc_mount_config_t mount = {
        .format_if_mount_failed = false, .max_files = 3,
        .allocation_unit_size = 16 * 1024,
    };
    esp_err_t e = esp_vfs_fat_sdmmc_mount("/sdcard", &host, &slot, &mount, &card);
    if (e != ESP_OK) { event("sd-card", "FAIL", esp_err_to_name(e)); if (sd_power) sd_pwr_ctrl_del_on_chip_ldo(sd_power); return false; }
    char path[96];
    snprintf(path, sizeof(path), "/sdcard/HDK_%08" PRIx32 ".TMP", esp_random());
    // Exclusively create a new file; never format or overwrite user data.
    int fd = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
    const char payload[] = "HDK exclusive file roundtrip 0123456789 abcdef\n";
    char readback[sizeof(payload)] = {0};
    bool good = fd >= 0;
    if (fd >= 0) {
        good &= write(fd, payload, sizeof(payload)) == (ssize_t)sizeof(payload);
        good &= fsync(fd) == 0;
        good &= lseek(fd, 0, SEEK_SET) == 0;
        good &= read(fd, readback, sizeof(readback)) == (ssize_t)sizeof(readback);
        good &= memcmp(payload, readback, sizeof(payload)) == 0;
        good &= close(fd) == 0;
        good &= unlink(path) == 0;
    }
    e = esp_vfs_fat_sdcard_unmount("/sdcard", card);
    good &= e == ESP_OK;
    if (sd_power) good &= sd_pwr_ctrl_del_on_chip_ldo(sd_power) == ESP_OK;
    event("sd-card", good ? "PASS" : "FAIL", "four_bit_exclusive_write_read_compare_cleanup");
    return good;
}

static bool camera_test(void) {
    if (!HDK_TEST_CAMERA_SCCB) return true;
    esp_err_t e;
    if (!camera_clock_started) {
        ledc_timer_config_t timer = {.speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_1_BIT,
            .timer_num = LEDC_TIMER_0, .freq_hz = 20000000, .clk_cfg = LEDC_AUTO_CLK};
        e = ledc_timer_config(&timer);
        if (e != ESP_OK) { event("camera-sccb", "FAIL", esp_err_to_name(e)); return false; }
        ledc_channel_config_t channel = {.gpio_num = HDK_CAMERA_XCLK, .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel = LEDC_CHANNEL_0, .intr_type = LEDC_INTR_DISABLE, .timer_sel = LEDC_TIMER_0,
            .duty = 1, .hpoint = 0};
        e = ledc_channel_config(&channel);
        if (e != ESP_OK) { event("camera-sccb", "FAIL", esp_err_to_name(e)); return false; }
        camera_clock_started = true;
    }
    if (!camera_bus) {
        i2c_master_bus_config_t bus = {.i2c_port = -1, .sda_io_num = HDK_CAMERA_SDA,
            .scl_io_num = HDK_CAMERA_SCL, .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
            .flags.enable_internal_pullup = false};
        e = i2c_new_master_bus(&bus, &camera_bus);
        if (e != ESP_OK) { event("camera-sccb", "FAIL", esp_err_to_name(e)); return false; }
        i2c_device_config_t device = {.dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = 0x3c, .scl_speed_hz = 100000};
        e = i2c_master_bus_add_device(camera_bus, &device, &camera_device);
        if (e != ESP_OK) { event("camera-sccb", "FAIL", esp_err_to_name(e)); return false; }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
    uint8_t high = 0, low = 0, reg = 0xf0;
    e = i2c_master_transmit_receive(camera_device, &reg, 1, &high, 1, 100);
    reg = 0xf1;
    if (e == ESP_OK) e = i2c_master_transmit_receive(camera_device, &reg, 1, &low, 1, 100);
    uint16_t pid = ((uint16_t)high << 8) | low;
    char detail[100]; snprintf(detail, sizeof(detail), "gc2145_pid=0x%04x scope=identity_only err=%s", pid, esp_err_to_name(e));
    bool good = e == ESP_OK && pid == 0x2145;
    event("camera-sccb", good ? "PASS" : "FAIL", detail);
    return good;
}

static void fixture_test(void) {
    if (!HDK_TEST_GPIO_LOOPBACK) return;
    if (HDK_FIXTURE_COUNT == 0) { event("gpio-loopback", "SKIP", "configuration_required"); return; }
    bool good = true;
    for (int pair = 0; pair < HDK_FIXTURE_COUNT; ++pair) { gpio_reset_pin(hdk_fixture_out[pair]); gpio_reset_pin(hdk_fixture_in[pair]); }
    for (int pair = 0; pair < HDK_FIXTURE_COUNT; ++pair) {
        for (int reverse = 0; reverse < 2; ++reverse) {
            int output = reverse ? hdk_fixture_in[pair] : hdk_fixture_out[pair];
            int input = reverse ? hdk_fixture_out[pair] : hdk_fixture_in[pair];
            gpio_reset_pin(output); gpio_reset_pin(input);
            gpio_set_direction(input, GPIO_MODE_INPUT);
            gpio_set_pull_mode(input, GPIO_PULLDOWN_ONLY);
            gpio_set_level(output, 0);
            gpio_set_direction(output, GPIO_MODE_OUTPUT);
            for (int level = 0; level <= 1; ++level) {
                gpio_set_level(output, level); vTaskDelay(pdMS_TO_TICKS(10));
                bool match = gpio_get_level(input) == level; good &= match;
                printf("HDK gpio-pair %s out=%d in=%d level=%d\n", match ? "PASS" : "FAIL", output, input, level);
            }
            gpio_set_level(output, 0); gpio_reset_pin(output); gpio_reset_pin(input);
        }
    }
    event("gpio-loopback", good ? "PASS" : "FAIL", "configured_pairs_only");
}

static void peripherals_test(void) {
    bool sd_ok = sd_test(), camera_ok = camera_test();
#if CONFIG_IDF_TARGET_ESP32P4
    if (HDK_TEST_MIPI_DSI) camera_ok &= hdk_mipi_display_test() == ESP_OK;
    if (HDK_TEST_MIPI_CSI) camera_ok &= hdk_mipi_camera_test() == ESP_OK;
    if (HDK_TEST_COMPANION_LINK) camera_ok &= hdk_c61_test_link() == ESP_OK;
    if (HDK_TEST_WIFI) camera_ok &= hdk_c61_wifi_scan() == ESP_OK;
    if (HDK_TEST_GPIO_LOOPBACK) camera_ok &= hdk_c61_fixture() == ESP_OK;
#endif
    result_red = 0; result_green = 0; result_blue = 0;
    if (!sd_ok) result_blue = 8;
    else if (!camera_ok) { result_red = 8; result_green = 8; }
    else result_green = 8;
    if (rgb_enabled) pixel(result_red, result_green, result_blue);
    event("peripheral-summary", sd_ok && camera_ok ? "PASS" : "FAIL", "not_a_full_board_or_fixture_certificate");
}

void app_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    esp_chip_info_t chip; esp_chip_info(&chip);
    uint32_t flash_size = 0; esp_err_t flash_e = esp_flash_get_size(NULL, &flash_size);
    printf("HDK chip-info %s target=%s model=%d cores=%u flash_bytes=%" PRIu32 " idf=%s source=%s profile_hash=%s\n",
        flash_e == ESP_OK ? "PASS" : "FAIL", CONFIG_IDF_TARGET, chip.model, chip.cores,
        flash_size, esp_get_idf_version(), HDK_BOARD_SOURCE_SHA256, HDK_CONFIG_SHA256);
    printf("HDK reset OBSERVED reason=%d\n", esp_reset_reason());
    if (HDK_BOOT_PIN >= 0 && HDK_TEST_BOOT_BUTTON) {
        gpio_config_t boot = {.pin_bit_mask = 1ULL << HDK_BOOT_PIN, .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE};
        ESP_ERROR_CHECK(gpio_config(&boot));
    }
#if CONFIG_IDF_TARGET_ESP32P4
    hdk_mipi_init();
    hdk_c61_init();
#endif
    rgb_test(); peripherals_test(); fixture_test();
#if CONFIG_IDF_TARGET_ESP32P4
#define HDK_COMMANDS "commands=help,rgb,sd,fixture,run,display,capture,link,wifi,c61-fixture,c61-download,c61-reset"
#else
#define HDK_COMMANDS "commands=help,rgb,sd,camera,fixture,run"
#endif
    event("usb-console", "READY", HDK_COMMANDS);
    int old_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (old_flags >= 0) fcntl(STDIN_FILENO, F_SETFL, old_flags | O_NONBLOCK);
    int last_button = 1, candidate = 1, stable_ticks = 0;
    char command[48] = {0}; size_t used = 0;
    while (true) {
        if (HDK_BOOT_PIN >= 0 && HDK_TEST_BOOT_BUTTON) {
            int value = gpio_get_level(HDK_BOOT_PIN);
            if (value != candidate) { candidate = value; stable_ticks = 0; }
            else if (++stable_ticks == 3 && value != last_button) {
                last_button = value; event("boot-button", value ? "RELEASED" : "PRESSED", "debounced");
                if (!value) { rgb_enabled = !rgb_enabled; pixel(rgb_enabled ? result_red : 0, rgb_enabled ? result_green : 0, rgb_enabled ? result_blue : 0); }
            }
        }
        int c = getchar();
        if (c == EOF) clearerr(stdin);
        else if (c == '\n' || c == '\r') {
            command[used] = 0;
            if (!strcmp(command, "rgb")) rgb_test();
            else if (!strcmp(command, "sd")) sd_test();
            else if (!strcmp(command, "camera")) camera_test();
            else if (!strcmp(command, "fixture")) fixture_test();
            else if (!strcmp(command, "run")) peripherals_test();
#if CONFIG_IDF_TARGET_ESP32P4
            else if (!strcmp(command, "display")) hdk_mipi_display_test();
            else if (!strcmp(command, "capture")) hdk_mipi_camera_test();
            else if (!strcmp(command, "link")) hdk_c61_test_link();
            else if (!strcmp(command, "wifi")) hdk_c61_wifi_scan();
            else if (!strcmp(command, "c61-fixture")) hdk_c61_fixture();
            else if (!strcmp(command, "c61-download")) hdk_c61_enter_download();
            else if (!strcmp(command, "c61-reset")) hdk_c61_reset();
#endif
            else if (used) event("help", "READY", HDK_COMMANDS);
            used = 0;
        } else if (used < sizeof(command) - 1) command[used++] = (char)c;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
