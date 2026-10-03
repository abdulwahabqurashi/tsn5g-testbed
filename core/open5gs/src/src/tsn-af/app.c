/*
 * Copyright (C) 2024 by Open5GS Contributors
 *
 * This file is part of Open5GS.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#include "ogs-app.h"

int app_initialize(const char *const argv[])
{
    int rv;

    rv = tsn_af_initialize();
    if (rv != OGS_OK) {
        ogs_error("Failed to initialize TSN-AF");
        return rv;
    }
    ogs_info("TSN-AF initialize...done");

    return OGS_OK;
}

void app_terminate(void)
{
    tsn_af_terminate();
    ogs_info("TSN-AF terminate...done");
}
