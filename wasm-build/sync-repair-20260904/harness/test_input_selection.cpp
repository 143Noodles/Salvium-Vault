// Test-only harness: exercises carrot::make_single_transfer_input_selector error reporting.
#include "carrot_impl/input_selection.h"
#include <cstring>
#include <iostream>

using namespace carrot;
static const rct::xmr_amount SAL = 100000000;

static InputCandidate cand(rct::xmr_amount amount, bool pre_carrot, uint8_t tag)
{
    InputCandidate c{};
    c.core.amount = amount;
    std::memset(&c.core.key_image, 0, sizeof(c.core.key_image));
    reinterpret_cast<unsigned char*>(&c.core.key_image)[0] = tag;
    reinterpret_cast<unsigned char*>(&c.core.key_image)[1] = pre_carrot ? 1 : 2;
    c.is_pre_carrot = pre_carrot;
    c.is_external = false;
    c.block_index = 100 + tag;
    return c;
}

static void run(const char *name, const std::vector<InputCandidate> &cands, rct::xmr_amount nominal)
{
    std::map<std::size_t, rct::xmr_amount> fees;
    for (std::size_t n = 1; n <= 64; ++n) fees[n] = 1000000 * n; // 0.01 SAL per input
    const std::vector<input_selection_policy_t> policies{&ispolicy::select_greedy_aging};
    std::set<size_t> picked;
    auto sel = make_single_transfer_input_selector(epee::to_span(cands), epee::to_span(policies), 0, &picked);
    std::vector<CarrotSelectedInput> out;
    try {
        sel(nominal, fees, 1, 0, out);
        std::cout << name << ": selected " << out.size() << " inputs" << std::endl;
    } catch (const std::exception &e) {
        std::cout << name << ": " << e.what() << std::endl;
    }
}

int main()
{
    // Balance split across input kinds: 3 x 10 SAL Carrot, 5 x 20 SAL pre-Carrot (not allowed in a normal transfer).
    std::vector<InputCandidate> mixed;
    for (uint8_t i = 0; i < 3; ++i) mixed.push_back(cand(10 * SAL, false, i));
    for (uint8_t i = 0; i < 5; ++i) mixed.push_back(cand(20 * SAL, true, 10 + i));
    run("mixed kinds, 50 SAL", mixed, 50 * SAL);
    // Best subset reported: top 3 inputs (30) vs 50 + fee(3) = 50.03 -> shortfall 20.03; 29.97 must succeed.
    run("mixed kinds, 29.97 SAL", mixed, 30 * SAL - 3000000);

    // More inputs than one tx can hold: 70 x 1 SAL.
    std::vector<InputCandidate> many;
    for (uint8_t i = 0; i < 70; ++i) many.push_back(cand(SAL, false, i));
    run("70 inputs, 69 SAL", many, 69 * SAL);
    // Reported minimum is at 64 inputs: 69 + 0.64; shortfall 5.64 -> 63.36 must succeed.
    run("70 inputs, 63.36 SAL", many, 64 * SAL - 64000000);
    return 0;
}
