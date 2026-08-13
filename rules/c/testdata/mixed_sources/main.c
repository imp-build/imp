#include <stdio.h>
#include <string.h>

#include "message.h"

int main(void) {
    const char *message = pilot_message();
    puts(message);
    return strcmp(message, "label pilot ok") == 0 ? 0 : 1;
}
