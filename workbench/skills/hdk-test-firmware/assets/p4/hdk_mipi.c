#include "hdk_mipi.h"
#include <stdint.h>
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_cache.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "linux/videodev2.h"
#include "wt_bsp.h"
#include "wt_bsp_dsi.h"
#include "wt_bsp_csi.h"

static volatile uint32_t frames, frame_crc;
static volatile size_t frame_bytes;
static volatile uint32_t frame_width, frame_height;

esp_err_t hdk_mipi_init(void)
{
    esp_err_t e = wt_bsp_init();
    printf("HDK mipi-init %s err=%s accessory_profile=ST7102_480x640_SC2336_1024x600\n", e == ESP_OK ? "READY" : "FAIL", esp_err_to_name(e));
    return e;
}

esp_err_t hdk_mipi_display_test(void)
{
    wt_bsp_dsi_t dsi = wt_bsp_get_dsi();
    if (!dsi) { printf("HDK mipi-dsi FAIL missing_panel_handle\n"); return ESP_ERR_NOT_FOUND; }
    uint16_t width = 0, height = 0;
    esp_err_t e = wt_bsp_dsi_get_resolution(dsi, &width, &height);
    esp_lcd_panel_handle_t panel = wt_bsp_dsi_get_panel_handle(dsi);
    void *buffer = NULL;
    if (e == ESP_OK && panel) e = esp_lcd_dpi_panel_get_frame_buffer(panel, 1, &buffer);
    if (e != ESP_OK || !buffer || !width || !height) {
        printf("HDK mipi-dsi FAIL framebuffer err=%s\n", esp_err_to_name(e)); return ESP_FAIL;
    }
    const uint8_t bars[8][3] = {{255,255,255},{255,255,0},{0,255,255},{0,255,0},{255,0,255},{255,0,0},{0,0,255},{0,0,0}};
    uint8_t *pixels = buffer;
    for (unsigned y = 0; y < height; ++y) {
        for (unsigned x = 0; x < width; ++x) {
            unsigned bar = x * 8 / width;
            for (unsigned c = 0; c < 3; ++c) pixels[(y * width + x) * 3 + c] = bars[bar][c];
        }
    }
    e = esp_cache_msync(buffer, (size_t)width * height * 3, ESP_CACHE_MSYNC_FLAG_DIR_C2M);
    if (e == ESP_OK) e = esp_lcd_panel_draw_bitmap(panel, 0, 0, width, height, buffer);
    if (e == ESP_OK) e = wt_bsp_dsi_display_on(dsi);
    printf("HDK mipi-dsi %s width=%u height=%u pattern=8_colour_bars err=%s operator_visual_confirmation_required\n", e == ESP_OK ? "EMITTED" : "FAIL", width, height, esp_err_to_name(e));
    return e;
}

static void captured(uint8_t *buffer, uint32_t width, uint32_t height, size_t length, void *unused)
{
    (void)unused;
    if (!buffer || !length || !width || !height) return;
    uint32_t crc = 0xffffffff;
    size_t sample = length < 4096 ? length : 4096;
    for (size_t i = 0; i < sample; ++i) {
        crc ^= buffer[i];
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (-(int32_t)(crc & 1)));
    }
    frame_width = width; frame_height = height; frame_bytes = length; frame_crc = ~crc;
    ++frames;
}

esp_err_t hdk_mipi_camera_test(void)
{
    wt_bsp_csi_t csi = wt_bsp_get_csi();
    if (!csi) { printf("HDK mipi-csi FAIL missing_camera_handle\n"); return ESP_ERR_NOT_FOUND; }
    frames = 0; frame_bytes = 0; frame_crc = 0;
    esp_err_t e = wt_bsp_csi_set_pixel_format(csi, V4L2_PIX_FMT_RGB565);
    if (e == ESP_OK) e = wt_bsp_csi_start(csi, captured, NULL);
    const int64_t deadline = esp_timer_get_time() + 5000000;
    while (e == ESP_OK && frames < 3 && esp_timer_get_time() < deadline) vTaskDelay(pdMS_TO_TICKS(25));
    bool received = frames >= 3 && frame_bytes > 0 && frame_width > 0 && frame_height > 0;
    esp_err_t stop = wt_bsp_csi_stop(csi);
    if (e == ESP_OK && stop != ESP_OK) e = stop;
    if (e == ESP_OK && !received) e = ESP_ERR_TIMEOUT;
    printf("HDK mipi-csi %s frames=%" PRIu32 " width=%" PRIu32 " height=%" PRIu32 " bytes=%u crc32_first_4096=%08" PRIx32 " err=%s scope=capture_not_image_quality\n",
        e == ESP_OK ? "PASS" : "FAIL", frames, frame_width, frame_height, (unsigned)frame_bytes, frame_crc, esp_err_to_name(e));
    return e;
}
