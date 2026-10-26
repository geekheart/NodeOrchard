#pragma once
#include "esp_err.h"

/** Initialize UART1/control pins from this package's companion_config.h. */
esp_err_t hdk_c61_init(void);
/** Reset into C61 application without erasing or flashing it. */
esp_err_t hdk_c61_reset(void);
/** HELLO roundtrip checks target, board hash and request ID. */
esp_err_t hdk_c61_test_link(void);
/** Run real C61 radio scan; zero AP records is not accepted as a pass. */
esp_err_t hdk_c61_wifi_scan(void);
/** Test only the two current ordinary C61 header loopback pairs. */
esp_err_t hdk_c61_fixture(void);
/** Hold C61 download strap/reset, then RELEASE P4 UART pins for external UART.
 * Connect only a 3.3V-level adapter, cross TX/RX, share GND, do not connect 5V.
 * To resume P4 testing after flashing, restart P4, then use link/wifi commands.
 */
esp_err_t hdk_c61_enter_download(void);
