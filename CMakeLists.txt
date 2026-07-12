zephyr_include_directories(include)
if(CONFIG_ZMK_KSCAN_DIAGNOSTICS)
    # Always-on feature code: compile-time topology tables + runtime stats.
    target_sources(app PRIVATE src/topology.c src/stats.c)

    if(CONFIG_ZMK_KSCAN_DIAGNOSTICS_MOCK_TIMING_TEST)
        target_sources(app PRIVATE src/test/kscan_mock_timing_test.c)
    endif()

    # The nanopb-generated proto and the shared query dispatch are needed by
    # both the central Studio RPC handler and the split peripheral relay path
    # (which runs the same dispatch against the peripheral's own DT tables).
    # The peripheral image has no ZMK_STUDIO, so this must NOT be gated on it.
    if(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC OR CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT)
        list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
        include(nanopb)
        set(NANOPB_GENERATE_CPP_APPEND_PATH TRUE)
        set(NANOPB_GENERATE_CPP_STANDALONE OFF)

        # NOTE: adding to app target directly causes build issues, so we create a library instead
        zephyr_library()
        file(GLOB_RECURSE PROTO_FILES ${CMAKE_CURRENT_SOURCE_DIR}/proto/*.proto)

        nanopb_generate_cpp(proto_srcs proto_hdrs RELPATH ${CMAKE_CURRENT_SOURCE_DIR} ${PROTO_FILES})
        target_include_directories(${ZEPHYR_CURRENT_LIBRARY} PUBLIC ${CMAKE_CURRENT_BINARY_DIR})
        target_sources(${ZEPHYR_CURRENT_LIBRARY} PRIVATE ${proto_srcs} ${proto_hdrs})

        # app should depend on the generated proto files
        target_include_directories(app PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/proto)
        add_dependencies(app ${ZEPHYR_CURRENT_LIBRARY})

        target_sources(app PRIVATE src/kscan_diagnostics_query.c)
    endif()

    if(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC)
        file(GLOB_RECURSE STUDIO_C_FILES ${CMAKE_CURRENT_SOURCE_DIR}/src/studio/*.c)
        target_sources(app PRIVATE ${STUDIO_C_FILES})

        if(CONFIG_ZMK_KSCAN_DIAGNOSTICS_STUDIO_RPC_TEST)
            target_sources(app PRIVATE src/test/kscan_diagnostics_rpc_test.c)
        endif()
    endif()

    # Split event-relay glue: relay queries to peripheral(s) and deliver their
    # topology/stats back to the PC as RPC notifications (DESIGN.md peripheral
    # relay section). Compiled on both split roles; the relay macros are
    # self-role-gating.
    if(CONFIG_ZMK_KSCAN_DIAGNOSTICS_SPLIT)
        file(GLOB_RECURSE SPLIT_C_FILES ${CMAKE_CURRENT_SOURCE_DIR}/src/split/*.c)
        target_sources(app PRIVATE ${SPLIT_C_FILES})
    endif()
endif()
