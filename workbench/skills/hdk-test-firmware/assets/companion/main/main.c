/** @file main.c
 *  @brief ESP32-C61 factory-test UART companion. No credentials or auto-connect.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "companion_config.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_chip_info.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define PROTOCOL_VERSION 1
#define MAX_LINE 192
#define MAX_AP_RECORDS 24
static esp_err_t s_wifi_status = ESP_FAIL;

static void fixture_inputs(void)
{
    for (int i = 0; i < HDK_C61_FIXTURE_COUNT; ++i) {
        gpio_reset_pin(hdk_c61_fixture_out[i]);
        gpio_reset_pin(hdk_c61_fixture_in[i]);
        gpio_set_direction(hdk_c61_fixture_out[i], GPIO_MODE_INPUT);
        gpio_set_direction(hdk_c61_fixture_in[i], GPIO_MODE_INPUT);
        gpio_set_pull_mode(hdk_c61_fixture_out[i], GPIO_FLOATING);
        gpio_set_pull_mode(hdk_c61_fixture_in[i], GPIO_FLOATING);
    }
}

static void send_json(cJSON *message)
{
    char *line = cJSON_PrintUnformatted(message);
    if (line != NULL) {
        uart_write_bytes(UART_NUM_0, line, strlen(line));
        uart_write_bytes(UART_NUM_0, "\n", 1);
        free(line);
    }
    cJSON_Delete(message);
}

static cJSON *event(const char *name, int request_id)
{
    cJSON *message = cJSON_CreateObject();
    cJSON_AddStringToObject(message, "event", name);
    cJSON_AddNumberToObject(message, "requestId", request_id);
    cJSON_AddNumberToObject(message, "protocol", PROTOCOL_VERSION);
    cJSON_AddStringToObject(message, "target", "esp32c61");
    return message;
}

static void hello(int request_id)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    cJSON *message = event("hello", request_id);
    cJSON_AddStringToObject(message, "boardSha256", HDK_C61_BOARD_SOURCE_SHA256);
    cJSON_AddNumberToObject(message, "revision", chip.revision);
    cJSON_AddNumberToObject(message, "cores", chip.cores);
    cJSON_AddStringToObject(message, "idf", esp_get_idf_version());
    send_json(message);
}

static void scan(int request_id)
{
    esp_err_t err = s_wifi_status;
    uint16_t count = MAX_AP_RECORDS;
    wifi_ap_record_t *records = NULL;
    if (err == ESP_OK) {
        wifi_scan_config_t config = {
            .ssid = NULL, .bssid = NULL, .channel = 0,
            .show_hidden = false, .scan_type = WIFI_SCAN_TYPE_ACTIVE,
            .scan_time.active = {.min = 60, .max = 120},
        };
        err = esp_wifi_scan_start(&config, true);
    }
    if (err == ESP_OK) {
        records = calloc(MAX_AP_RECORDS, sizeof(wifi_ap_record_t));
        if (records == NULL) err = ESP_ERR_NO_MEM;
    }
    if (err == ESP_OK) err = esp_wifi_scan_get_ap_records(&count, records);
    if (err == ESP_OK) {
        for (uint16_t i = 0; i < count; ++i) {
            cJSON *message = event("ap", request_id);
            records[i].ssid[sizeof(records[i].ssid) - 1] = '\0';
            cJSON_AddStringToObject(message, "ssid", (const char *)records[i].ssid);
            cJSON_AddNumberToObject(message, "rssi", records[i].rssi);
            cJSON_AddNumberToObject(message, "channel", records[i].primary);
            cJSON_AddNumberToObject(message, "authmode", records[i].authmode);
            send_json(message);
        }
    } else {
        count = 0;
        /* Free SDK scan records when an allocation/parse failure interrupted us. */
        esp_wifi_clear_ap_list();
    }
    free(records);
    cJSON *done = event("scan_done", request_id);
    cJSON_AddStringToObject(done, "status", err != ESP_OK ? "error" : (count ? "ok" : "empty"));
    cJSON_AddNumberToObject(done, "count", count);
    cJSON_AddStringToObject(done, "error", esp_err_to_name(err));
    send_json(done);
}

static void fixture(int request_id)
{
    unsigned checks = 0, errors = 0;
    for (int pair = 0; pair < HDK_C61_FIXTURE_COUNT; ++pair) {
        for (int direction = 0; direction < 2; ++direction) {
            fixture_inputs();
            int output = direction ? hdk_c61_fixture_in[pair] : hdk_c61_fixture_out[pair];
            int input = direction ? hdk_c61_fixture_out[pair] : hdk_c61_fixture_in[pair];
            esp_err_t err = gpio_set_direction(output, GPIO_MODE_OUTPUT);
            for (int level = 0; level < 2; ++level) {
                if (gpio_set_level(output, level) != ESP_OK) err = ESP_FAIL;
                vTaskDelay(pdMS_TO_TICKS(20));
                int observed = gpio_get_level(input);
                bool match = err == ESP_OK && observed == level;
                checks++; if (!match) errors++;
                cJSON *record = event("fixture_step", request_id);
                cJSON_AddNumberToObject(record, "out", output);
                cJSON_AddNumberToObject(record, "in", input);
                cJSON_AddNumberToObject(record, "expected", level);
                cJSON_AddNumberToObject(record, "observed", observed);
                cJSON_AddBoolToObject(record, "match", match);
                send_json(record);
            }
        }
    }
    fixture_inputs();
    cJSON *done = event("fixture_done", request_id);
    cJSON_AddStringToObject(done, "status", errors ? "error" : "ok");
    cJSON_AddNumberToObject(done, "pairs", HDK_C61_FIXTURE_COUNT);
    cJSON_AddNumberToObject(done, "gpios", HDK_C61_FIXTURE_COUNT * 2);
    cJSON_AddNumberToObject(done, "checks", checks);
    cJSON_AddNumberToObject(done, "errors", errors);
    send_json(done);
}
static esp_err_t wifi_init(void)
{
    esp_err_t err = nvs_flash_init();
    /* Keep existing NVS on error; factory testing does not silently erase it. */
    if (err != ESP_OK) return err;
    if ((err = esp_netif_init()) != ESP_OK) return err;
    if ((err = esp_event_loop_create_default()) != ESP_OK) return err;
    if (esp_netif_create_default_wifi_sta() == NULL) return ESP_ERR_NO_MEM;
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    if ((err = esp_wifi_init(&config)) != ESP_OK) return err;
    if ((err = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK) return err;
    if ((err = esp_wifi_set_mode(WIFI_MODE_STA)) != ESP_OK) return err;
    return esp_wifi_start();
}

static void handle_line(char *line)
{
    cJSON *request = cJSON_Parse(line);
    if (request == NULL) return;
    cJSON *command = cJSON_GetObjectItemCaseSensitive(request, "cmd");
    cJSON *id = cJSON_GetObjectItemCaseSensitive(request, "requestId");
    int request_id = cJSON_IsNumber(id) ? id->valueint : 0;
    if (cJSON_IsString(command) && strcmp(command->valuestring, "hello") == 0) hello(request_id);
    else if (cJSON_IsString(command) && strcmp(command->valuestring, "scan") == 0) scan(request_id);
    else if (cJSON_IsString(command) && strcmp(command->valuestring, "fixture") == 0) fixture(request_id);
    else {
        cJSON *error = event("error", request_id);
        cJSON_AddStringToObject(error, "error", "unknown_command");
        send_json(error);
    }
    cJSON_Delete(request);
}

void app_main(void)
{
    esp_log_level_set("*", ESP_LOG_WARN);
    uart_config_t config = {
        .baud_rate = 115200, .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &config));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_0, HDK_C61_UART_TX, HDK_C61_UART_RX,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 2048, 2048, 0, NULL, 0));
    s_wifi_status = wifi_init();
    hello(0);
    char line[MAX_LINE]; size_t used = 0; bool discard = false;
    while (true) {
        uint8_t byte;
        if (uart_read_bytes(UART_NUM_0, &byte, 1, pdMS_TO_TICKS(100)) != 1) continue;
        if (byte == '\n') {
            if (!discard && used > 0) {line[used] = '\0'; handle_line(line);}
            used = 0; discard = false;
        } else if (byte != '\r') {
            if (used + 1 < sizeof(line) && !discard) line[used++] = (char)byte;
            else discard = true;
        }
    }
}
