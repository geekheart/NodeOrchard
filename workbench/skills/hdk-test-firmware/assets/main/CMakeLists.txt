idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES esp_driver_gpio esp_driver_rmt esp_driver_ledc esp_driver_i2c fatfs sdmmc esp_system esp_hw_support spi_flash vfs)
