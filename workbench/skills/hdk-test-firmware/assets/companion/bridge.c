/** @file bridge.c
 *  @brief P4 side of a bounded C61 JSON-line factory-test link.
 */
#include "bridge.h"
#include "companion_config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define C61_UART UART_NUM_1
#define MAX_LINE 512
static bool s_ready;

static int request_id(void)
{
    /* Zero is reserved for unsolicited C61 startup announcements. */
    return (int)(esp_random() & 0x7ffffffe) + 1;
}

esp_err_t hdk_c61_init(void)
{
    if (s_ready) return ESP_OK;
    gpio_config_t pins = {
        .pin_bit_mask = (1ULL << HDK_P4_C61_RESET) | (1ULL << HDK_P4_C61_BOOT),
        .mode = GPIO_MODE_OUTPUT, .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&pins);
    if (err != ESP_OK) return err;
    gpio_set_level(HDK_P4_C61_BOOT, 1);
    gpio_set_level(HDK_P4_C61_RESET, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(HDK_P4_C61_RESET, 1);
    uart_config_t config = {
        .baud_rate = 115200, .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
    };
    if ((err = uart_param_config(C61_UART, &config)) != ESP_OK) return err;
    if ((err = uart_set_pin(C61_UART, HDK_P4_C61_TX, HDK_P4_C61_RX,
                            UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE)) != ESP_OK) return err;
    if ((err = uart_driver_install(C61_UART, 4096, 2048, 0, NULL, 0)) != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(500));
    s_ready = true;
    return ESP_OK;
}

esp_err_t hdk_c61_reset(void)
{
    esp_err_t err = hdk_c61_init();
    if (err != ESP_OK) return err;
    gpio_set_level(HDK_P4_C61_BOOT, 1);
    gpio_set_level(HDK_P4_C61_RESET, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(HDK_P4_C61_RESET, 1);
    vTaskDelay(pdMS_TO_TICKS(500));
    return ESP_OK;
}

static esp_err_t send_command(const char *command, int request_id)
{
    esp_err_t err = hdk_c61_init();
    if (err != ESP_OK) return err;
    uart_flush_input(C61_UART);
    char request[96];
    int len = snprintf(request, sizeof(request), "{\"cmd\":\"%s\",\"requestId\":%d}\n", command, request_id);
    return uart_write_bytes(C61_UART, request, len) == len ? ESP_OK : ESP_FAIL;
}

static cJSON *read_reply(int request_id, int64_t deadline)
{
    char line[MAX_LINE]; size_t used = 0; bool discard = false;
    while (esp_timer_get_time() < deadline) {
        uint8_t byte;
        if (uart_read_bytes(C61_UART, &byte, 1, pdMS_TO_TICKS(50)) != 1) continue;
        if (byte == '\n') {
            if (!discard && used > 0) {
                line[used] = '\0';
                cJSON *reply = cJSON_Parse(line);
                if (reply != NULL) {
                    cJSON *id = cJSON_GetObjectItemCaseSensitive(reply, "requestId");
                    cJSON *version = cJSON_GetObjectItemCaseSensitive(reply, "protocol");
                    cJSON *target = cJSON_GetObjectItemCaseSensitive(reply, "target");
                    if (cJSON_IsNumber(id) && id->valueint == request_id &&
                        cJSON_IsNumber(version) && version->valueint == 1 &&
                        cJSON_IsString(target) && strcmp(target->valuestring, "esp32c61") == 0) return reply;
                    cJSON_Delete(reply);
                }
            }
            used = 0; discard = false;
        } else if (byte != '\r') {
            if (used + 1 < sizeof(line) && !discard) line[used++] = (char)byte;
            else discard = true;
        }
    }
    return NULL;
}

esp_err_t hdk_c61_test_link(void)
{
    int id = request_id();
    esp_err_t err = send_command("hello", id);
    if (err != ESP_OK) return err;
    cJSON *reply = read_reply(id, esp_timer_get_time() + 3000000);
    if (reply == NULL) {printf("HDK companion-link FAIL timeout\n"); return ESP_ERR_TIMEOUT;}
    cJSON *kind = cJSON_GetObjectItemCaseSensitive(reply, "event");
    cJSON *sha = cJSON_GetObjectItemCaseSensitive(reply, "boardSha256");
    bool valid = cJSON_IsString(kind) && strcmp(kind->valuestring, "hello") == 0 &&
        cJSON_IsString(sha) && strcmp(sha->valuestring, HDK_C61_BOARD_SOURCE_SHA256) == 0;
    cJSON_Delete(reply);
    printf("HDK companion-link %s target=esp32c61 board_sha_checked\n", valid ? "PASS" : "FAIL");
    return valid ? ESP_OK : ESP_FAIL;
}

esp_err_t hdk_c61_wifi_scan(void)
{
    esp_err_t err = hdk_c61_test_link();
    if (err != ESP_OK) return err;
    int id = request_id();
    if ((err = send_command("scan", id)) != ESP_OK) return err;
    int64_t deadline = esp_timer_get_time() + 25000000;
    unsigned received = 0;
    while (esp_timer_get_time() < deadline) {
        cJSON *reply = read_reply(id, deadline);
        if (reply == NULL) break;
        cJSON *kind = cJSON_GetObjectItemCaseSensitive(reply, "event");
        if (cJSON_IsString(kind) && strcmp(kind->valuestring, "ap") == 0) {
            char *json = cJSON_PrintUnformatted(reply);
            if (json) {printf("HDK wifi AP %s\n", json); free(json);}
            received++;
        } else if (cJSON_IsString(kind) && strcmp(kind->valuestring, "scan_done") == 0) {
            cJSON *status = cJSON_GetObjectItemCaseSensitive(reply, "status");
            cJSON *count = cJSON_GetObjectItemCaseSensitive(reply, "count");
            bool valid = cJSON_IsString(status) && strcmp(status->valuestring, "ok") == 0 &&
                cJSON_IsNumber(count) && count->valueint > 0 && (unsigned)count->valueint == received;
            printf("HDK wifi %s ap_count=%u\n", valid ? "PASS" : "FAIL", received);
            cJSON_Delete(reply);
            return valid ? ESP_OK : ESP_FAIL;
        }
        cJSON_Delete(reply);
    }
    printf("HDK wifi FAIL timeout\n");
    return ESP_ERR_TIMEOUT;
}

esp_err_t hdk_c61_fixture(void)
{
    esp_err_t err = hdk_c61_test_link();
    if (err != ESP_OK) return err;
    int id = request_id();
    if ((err = send_command("fixture", id)) != ESP_OK) return err;
    int64_t deadline = esp_timer_get_time() + 5000000;
    unsigned received = 0, failed_steps = 0, seen_mask = 0;
    while (esp_timer_get_time() < deadline) {
        cJSON *reply = read_reply(id, deadline);
        if (reply == NULL) break;
        cJSON *kind = cJSON_GetObjectItemCaseSensitive(reply, "event");
        if (cJSON_IsString(kind) && strcmp(kind->valuestring, "fixture_step") == 0) {
            cJSON *match = cJSON_GetObjectItemCaseSensitive(reply, "match");
            cJSON *output = cJSON_GetObjectItemCaseSensitive(reply, "out");
            cJSON *input = cJSON_GetObjectItemCaseSensitive(reply, "in");
            cJSON *expected = cJSON_GetObjectItemCaseSensitive(reply, "expected");
            cJSON *observed = cJSON_GetObjectItemCaseSensitive(reply, "observed");
            int slot = -1;
            if (cJSON_IsNumber(output) && cJSON_IsNumber(input) && cJSON_IsNumber(expected) &&
                cJSON_IsNumber(observed) && (expected->valueint == 0 || expected->valueint == 1)) {
                for (int pair = 0; pair < HDK_C61_FIXTURE_COUNT; ++pair) {
                    if (output->valueint == hdk_c61_fixture_out[pair] && input->valueint == hdk_c61_fixture_in[pair])
                        slot = pair*4 + expected->valueint;
                    if (output->valueint == hdk_c61_fixture_in[pair] && input->valueint == hdk_c61_fixture_out[pair])
                        slot = pair*4 + 2 + expected->valueint;
                }
            }
            if (!cJSON_IsTrue(match) || slot < 0 || observed->valueint != expected->valueint || (seen_mask & (1U << slot))) failed_steps++;
            if (slot >= 0) seen_mask |= (1U << slot);
            char *json = cJSON_PrintUnformatted(reply);
            if (json) {printf("HDK companion-gpio-loopback STEP %s\n", json); free(json);}
            received++;
        } else if (cJSON_IsString(kind) && strcmp(kind->valuestring, "fixture_done") == 0) {
            cJSON *status = cJSON_GetObjectItemCaseSensitive(reply, "status");
            cJSON *pairs = cJSON_GetObjectItemCaseSensitive(reply, "pairs");
            cJSON *gpios = cJSON_GetObjectItemCaseSensitive(reply, "gpios");
            cJSON *checks = cJSON_GetObjectItemCaseSensitive(reply, "checks");
            cJSON *errors = cJSON_GetObjectItemCaseSensitive(reply, "errors");
            bool valid = cJSON_IsString(status) && strcmp(status->valuestring, "ok") == 0 &&
                cJSON_IsNumber(pairs) && pairs->valueint == HDK_C61_FIXTURE_COUNT &&
                cJSON_IsNumber(gpios) && gpios->valueint == HDK_C61_FIXTURE_COUNT*2 &&
                cJSON_IsNumber(checks) && checks->valueint == HDK_C61_FIXTURE_COUNT*4 &&
                cJSON_IsNumber(errors) && errors->valueint == 0 && failed_steps == 0 &&
                received == HDK_C61_FIXTURE_COUNT*4 && seen_mask == ((1U << (HDK_C61_FIXTURE_COUNT*4))-1);
            printf("HDK companion-gpio-loopback %s pairs=%d gpios=%d checks=%u\n",
                valid ? "PASS" : "FAIL", HDK_C61_FIXTURE_COUNT, HDK_C61_FIXTURE_COUNT*2, received);
            cJSON_Delete(reply);
            return valid ? ESP_OK : ESP_FAIL;
        }
        cJSON_Delete(reply);
    }
    printf("HDK companion-gpio-loopback FAIL timeout\n");
    return ESP_ERR_TIMEOUT;
}

esp_err_t hdk_c61_enter_download(void)
{
    esp_err_t err = hdk_c61_init();
    if (err != ESP_OK) return err;
    gpio_set_level(HDK_P4_C61_BOOT, 0);
    gpio_set_level(HDK_P4_C61_RESET, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(HDK_P4_C61_RESET, 1);
    vTaskDelay(pdMS_TO_TICKS(100));
    uart_wait_tx_done(C61_UART, pdMS_TO_TICKS(100));
    uart_driver_delete(C61_UART);
    gpio_reset_pin(HDK_P4_C61_TX); gpio_set_direction(HDK_P4_C61_TX, GPIO_MODE_INPUT);
    gpio_reset_pin(HDK_P4_C61_RX); gpio_set_direction(HDK_P4_C61_RX, GPIO_MODE_INPUT);
    s_ready = false;
    printf("HDK companion DOWNLOAD external_uart_ready GPIO9_low P4_UART_released\n");
    return ESP_OK;
}
