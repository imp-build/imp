#include <stdio.h>
#include <string.h>

#include "message.h"

int main(void) {
    const char *message = graph_pilot_message();
    puts(message);
    return strcmp(message, "graph pilot ok") == 0 ? 0 : 1;
}
